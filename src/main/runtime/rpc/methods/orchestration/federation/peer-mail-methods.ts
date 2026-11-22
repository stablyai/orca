import type { RpcContext } from '../../../core'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isGeneratedId } from '../../../../orchestration/db/generated-id'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { FederationRelayItemRow } from '../../../../orchestration/db/orchestration-records'
import { resolveBareOrchestrationRecipient } from '../messaging/recipient-routing'
import { prepareSessionRecipient } from '../messaging/session-recipient'
import { withDeliveryHoldWarning } from '../messaging/send-delivery-hold'
import { deliverPeerMailToBot } from './peer-mail-bot-delivery'
import { peerMailSenderSnapshot } from '../../../../orchestration/federation/peer-mail/peer-mail-sender-snapshot'
import { waitForPeerMail } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import {
  PeerMailAckParams,
  PeerMailDeliverParams,
  PeerMailPullParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import {
  clientEnvironmentId,
  isClientEnvironment
} from '../../../../orchestration/federation/client-asks/client-ask-environment'
import {
  clientAskPullEnded,
  clientAskPullStarted
} from '../../../../orchestration/federation/client-asks/client-ask-listeners'
import { settleReplacedClientPairing } from '../../../../orchestration/federation/client-asks/client-ask-queue'

const NOTHING_DELIVERED = { effectsApplied: false } as const
const MAX_PULL_WAIT_MS = 25_000
const PULL_PAGE_SIZE = 50

/** Mail between servers comes only from a paired computer's Orca, never a phone or this Orca's own clients. */
export function requireRuntimePairing(
  ctx: Pick<RpcContext, 'clientKind' | 'pairedDeviceId' | 'authenticatedCallerFingerprint'>
): string {
  if (
    ctx.clientKind !== 'runtime' ||
    ctx.pairedDeviceId === undefined ||
    !ctx.authenticatedCallerFingerprint
  ) {
    throw new OrchestrationError(
      'mail_requires_server_pairing',
      'Agent mail between Orca servers comes only from a paired computer. Nothing was delivered.',
      NOTHING_DELIVERED
    )
  }
  return ctx.authenticatedCallerFingerprint
}

// Where each pairing's next page starts, per database, when more conversations are pending than a page holds.
const pullRotations = new WeakMap<object, Map<string, number>>()

/** Every conversation with pending items gets an equal share of the page, so an item the paired Orca
 *  cannot import yet, which stays at its conversation's head, never starves another conversation. */
function pendingReplies(
  db: OrchestrationDb,
  peerFingerprint: string,
  holdBack: ReadonlySet<string>,
  clientEnvironment: string | null
): FederationRelayItemRow[] {
  const pending = db
    .listPeerConversationIdsWithPendingReplies(peerFingerprint, clientEnvironment)
    .filter((id) => !holdBack.has(id))
  const share = Math.max(1, Math.floor(PULL_PAGE_SIZE / pending.length))
  const pullRotation = pullRotations.get(db.db) ?? new Map<string, number>()
  pullRotations.set(db.db, pullRotation)
  const start = pending.length > PULL_PAGE_SIZE ? (pullRotation.get(peerFingerprint) ?? 0) : 0
  pullRotation.set(peerFingerprint, (start + PULL_PAGE_SIZE) % Math.max(1, pending.length))
  return [...pending.slice(start), ...pending.slice(0, start)]
    .slice(0, PULL_PAGE_SIZE)
    .flatMap((id) => db.listPendingFederationRelay(id, relayDirectionOf(db, id), share))
    .slice(0, PULL_PAGE_SIZE)
}

/** A conversation this Orca opened with a paired computer carries asks to it; any other, replies home. */
function relayDirectionOf(db: OrchestrationDb, conversationId: string): 'to_home' | 'to_worker' {
  return db.getPeerMailConversation(conversationId)?.role === 'home' ? 'to_worker' : 'to_home'
}

export const ORCHESTRATION_PEER_MAIL_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.peerMailDeliver',
    access: {
      kind: 'localOnly',
      targets: {
        conversationId: 'conversation',
        messageId: 'message',
        to: 'party',
        threadId: 'message'
      }
    },
    permission: 'workspace',
    params: PeerMailDeliverParams,
    handler: async (params, ctx) => {
      const peerFingerprint = requireRuntimePairing(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      if (!isGeneratedId(params.messageId, 'msg')) {
        throw new OrchestrationError('invalid_argument', 'Mail between servers needs a message ID.')
      }
      // Replies wait in the relay keyed by conversation; any other id could name another Orca's dispatch there.
      if (!isGeneratedId(params.conversationId, 'peerconv')) {
        throw new OrchestrationError(
          'invalid_argument',
          'Mail between servers needs a conversation ID.',
          NOTHING_DELIVERED
        )
      }
      if (/^(run|dispatch|task):/.test(params.to) || params.to.startsWith('@')) {
        throw new OrchestrationError(
          'invalid_argument',
          `--on sends to one agent or bot on this server; ${params.to} is a mailbox. Nothing was delivered.`,
          NOTHING_DELIVERED
        )
      }
      // A retry after a lost answer is acknowledged even if the recipient has since gone.
      const delivered = async (): Promise<{ message: { id: string; to: string } } | null> => {
        const message = db.getPeerMailMessage(params.messageId)
        if (!message) {
          return null
        }
        const conversation = db.getPeerMailConversation(message.conversation_id)
        if (
          message.conversation_id !== params.conversationId ||
          conversation?.peer_fingerprint !== peerFingerprint
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Message ${params.messageId} already belongs to another conversation. Nothing was delivered.`,
            NOTHING_DELIVERED
          )
        }
        const receipt = { message: { id: params.messageId, to: params.to } }
        const stored = db.getMessageById(params.messageId)
        // A retry reads the hold again; bot mail reports none, as its first answer did, and read mail is held no longer.
        return !stored || db.getBotRequest(params.messageId)
          ? receipt
          : withDeliveryHoldWarning(receipt, runtime, db, stored.to_handle, stored.read !== 0)
      }
      // A replay needs no routing, so it never waits on the recipient's preparation.
      const replayed = await delivered()
      if (replayed) {
        return replayed
      }
      const senderSnapshot = peerMailSenderSnapshot(params.senderLabel, params.sender)
      const routed = await deliverPeerMailToBot(runtime, params, peerFingerprint, senderSnapshot)
      if (routed === 'delivered') {
        return { message: { id: params.messageId, to: params.to } }
      }
      const { to, body = params.body } = routed
      const terminalRecipient = await prepareSessionRecipient(runtime, to)
      // Read again after the wait: a copy of this delivery may have landed meanwhile.
      const landed = await delivered()
      if (landed) {
        return landed
      }
      const recipient = resolveBareOrchestrationRecipient({
        runtime,
        db,
        handle: to,
        terminalRecipient
      })
      if (!recipient.ok) {
        throw new OrchestrationError(
          recipient.code,
          `${recipient.message} Nothing was delivered.`,
          NOTHING_DELIVERED
        )
      }
      const paneKey = runtime.getLiveTerminalPaneKey(recipient.to)
      if (paneKey && db.findActiveRemoteAttachmentForPane(paneKey)) {
        // Its mailbox is its Dispatch, which only its Run home writes to.
        throw new OrchestrationError(
          'invalid_argument',
          `${to} is a worker for another Orca's Run; message it through that Run's coordinator. Nothing was delivered.`,
          NOTHING_DELIVERED
        )
      }
      // Before storing, as a local send does: a waiter the arrival resolves is gone by the time the receipt reads.
      const takenByWaiter = runtime.hasMessageWaiterFor(recipient.to, params.type ?? 'status')
      const stored = db.insertPeerMailMessage({
        conversationId: params.conversationId,
        peerFingerprint,
        remoteParty: null,
        message: {
          id: params.messageId,
          from: params.senderLabel,
          to: recipient.to,
          subject: params.subject,
          body,
          type: params.type,
          priority: params.priority,
          threadId: params.threadId,
          runId: recipient.runId,
          answerSenderSnapshot: senderSnapshot
        }
      })
      if (!stored.duplicate) {
        runtime.notifyMessageArrived(stored.message.to_handle, stored.message.type)
      }
      // An older sending Orca ignores the warnings; the sender learns the mail waits unread.
      return withDeliveryHoldWarning(
        { message: { id: params.messageId, to: params.to } },
        runtime,
        db,
        recipient.to,
        takenByWaiter
      )
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.peerMailPull',
    access: { kind: 'localOnly', targets: {} },
    permission: 'workspace',
    params: PeerMailPullParams,
    handler: async (params, ctx) => {
      const peerFingerprint = requireRuntimePairing(ctx)
      const asks = params.clientAsks
      // A paired computer taking asks listens for as long as its session's pulls keep coming.
      const listening =
        asks && ctx.pairedDeviceId
          ? clientAskPullStarted(
              ctx.runtime,
              { deviceId: ctx.pairedDeviceId, fingerprint: peerFingerprint },
              asks
            )
          : null
      if (asks && ctx.pairedDeviceId && asks.previousPairing) {
        settleReplacedClientPairing(ctx.runtime, {
          previousPairing: asks.previousPairing,
          currentFingerprint: peerFingerprint,
          installationId: asks.installationId,
          name: asks.name
        })
      }
      const seenAs = asks ? { clientAsks: { seenAs: peerFingerprint } } : {}
      if (asks?.leave) {
        return { items: [], ...seenAs }
      }
      const clientEnvironment =
        asks && ctx.pairedDeviceId
          ? clientEnvironmentId(ctx.pairedDeviceId, asks.installationId)
          : null
      try {
        const db = ctx.runtime.getOrchestrationDb()
        const holdBack = new Set(params.holdBack)
        let items = pendingReplies(db, peerFingerprint, holdBack, clientEnvironment)
        const waitMs = Math.min(Math.max(params.waitMs ?? 0, 0), MAX_PULL_WAIT_MS)
        const deadline = Date.now() + waitMs
        // A wake is any queued change on this Orca, so one that queued nothing for this peer waits on.
        while (items.length === 0 && Date.now() < deadline && !ctx.signal?.aborted) {
          await waitForPeerMail(db.db, deadline - Date.now(), ctx.signal)
          items = pendingReplies(
            ctx.runtime.getOrchestrationDb(),
            peerFingerprint,
            holdBack,
            clientEnvironment
          )
        }
        return {
          items: items.map((item) => ({
            conversationId: item.dispatch_id,
            sequence: item.sequence,
            messageId: item.message_id,
            kind: item.kind,
            payload: item.payload
          })),
          ...seenAs
        }
      } finally {
        if (listening) {
          clientAskPullEnded(
            ctx.runtime,
            listening,
            ctx.signal?.aborted ? 'caller_gone' : 'answered'
          )
        }
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.peerMailAck',
    access: { kind: 'localOnly', targets: {} },
    permission: 'workspace',
    params: PeerMailAckParams,
    handler: (params, ctx) => {
      const peerFingerprint = requireRuntimePairing(ctx)
      const db = ctx.runtime.getOrchestrationDb()
      for (const ack of params.acknowledgments) {
        const conversation = db.getPeerMailConversation(ack.conversationId)
        if (!conversation || conversation.peer_fingerprint !== peerFingerprint) {
          continue
        }
        // Asks it took from this Orca's conversation with it, or replies it took home.
        const asks =
          conversation.role === 'home' && isClientEnvironment(conversation.environment_id)
        if (conversation.role !== 'peer' && !asks) {
          continue
        }
        db.acknowledgeFederationRelay({
          dispatchId: ack.conversationId,
          direction: asks ? 'to_worker' : 'to_home',
          throughSequence: ack.throughSequence
        })
      }
      return { acknowledged: params.acknowledgments.length }
    }
  })
]
