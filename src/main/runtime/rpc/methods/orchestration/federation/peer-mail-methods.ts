import { defineMethod, type RpcContext } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isGeneratedId } from '../../../../orchestration/db/generated-id'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { FederationRelayItemRow } from '../../../../orchestration/db/orchestration-records'
import { resolveBareOrchestrationRecipient } from '../messaging/recipient-routing'
import { mayNameSession } from '../messaging/session-recipient'
import { waitForPeerMail } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import {
  PeerMailAckParams,
  PeerMailDeliverParams,
  PeerMailPullParams
} from '../../../../../../shared/rpc-contract/orchestration-peer-mail-params'

const NOTHING_DELIVERED = { effectsApplied: false } as const
const MAX_PULL_WAIT_MS = 25_000
const PULL_PAGE_SIZE = 50

/** Mail between servers comes only from a paired computer's Orca, never a phone or this Orca's own clients. */
function requireRuntimePairing(
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

function pendingReplies(db: OrchestrationDb, peerFingerprint: string): FederationRelayItemRow[] {
  const items: FederationRelayItemRow[] = []
  for (const conversationId of db.listPeerConversationIds(peerFingerprint)) {
    if (items.length >= PULL_PAGE_SIZE) {
      break
    }
    items.push(
      ...db.listPendingFederationRelay(conversationId, 'to_home', PULL_PAGE_SIZE - items.length)
    )
  }
  return items
}

export const ORCHESTRATION_PEER_MAIL_METHODS = [
  defineMethod({
    name: 'orchestration.peerMailDeliver',
    permission: 'workspace',
    params: PeerMailDeliverParams,
    handler: async (params, ctx) => {
      const peerFingerprint = requireRuntimePairing(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      if (!isGeneratedId(params.messageId, 'msg')) {
        throw new OrchestrationError('invalid_argument', 'Mail between servers needs a message ID.')
      }
      const to = params.to
      if (/^(run|dispatch|task):/.test(to) || to.startsWith('@')) {
        throw new OrchestrationError(
          'invalid_argument',
          `--on sends to one terminal or chat agent on this server; ${to} is a mailbox. Nothing was delivered.`,
          NOTHING_DELIVERED
        )
      }
      // A retry after a lost answer is acknowledged even if the recipient has since gone.
      const delivered = db.getPeerMailMessage(params.messageId)
      if (delivered) {
        const conversation = db.getPeerMailConversation(delivered.conversation_id)
        if (
          delivered.conversation_id !== params.conversationId ||
          conversation?.peer_fingerprint !== peerFingerprint
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Message ${params.messageId} already belongs to another conversation. Nothing was delivered.`,
            NOTHING_DELIVERED
          )
        }
        return { message: { id: params.messageId, to } }
      }
      if (mayNameSession(to)) {
        // Recipient routing reads the session record store, which the host opens lazily.
        await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      }
      const recipient = resolveBareOrchestrationRecipient({ runtime, db, handle: to })
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
      const stored = db.insertPeerMailMessage({
        conversationId: params.conversationId,
        peerFingerprint,
        remoteParty: null,
        message: {
          id: params.messageId,
          from: params.senderLabel,
          to: recipient.to,
          subject: params.subject,
          body: params.body,
          type: params.type,
          priority: params.priority,
          threadId: params.threadId,
          runId: recipient.runId
        }
      })
      if (!stored.duplicate) {
        runtime.notifyMessageArrived(stored.message.to_handle, stored.message.type)
      }
      return { message: { id: stored.message.id, to } }
    }
  }),
  defineMethod({
    name: 'orchestration.peerMailPull',
    permission: 'workspace',
    params: PeerMailPullParams,
    handler: async (params, ctx) => {
      const peerFingerprint = requireRuntimePairing(ctx)
      const db = ctx.runtime.getOrchestrationDb()
      let items = pendingReplies(db, peerFingerprint)
      const waitMs = Math.min(Math.max(params.waitMs ?? 0, 0), MAX_PULL_WAIT_MS)
      if (items.length === 0 && waitMs > 0) {
        await waitForPeerMail(db, waitMs, ctx.signal)
        items = pendingReplies(ctx.runtime.getOrchestrationDb(), peerFingerprint)
      }
      return {
        items: items.map((item) => ({
          conversationId: item.dispatch_id,
          sequence: item.sequence,
          messageId: item.message_id,
          payload: item.payload
        }))
      }
    }
  }),
  defineMethod({
    name: 'orchestration.peerMailAck',
    permission: 'workspace',
    params: PeerMailAckParams,
    handler: (params, ctx) => {
      const peerFingerprint = requireRuntimePairing(ctx)
      const db = ctx.runtime.getOrchestrationDb()
      for (const ack of params.acknowledgments) {
        const conversation = db.getPeerMailConversation(ack.conversationId)
        if (conversation?.role !== 'peer' || conversation.peer_fingerprint !== peerFingerprint) {
          continue
        }
        db.acknowledgeFederationRelay({
          dispatchId: ack.conversationId,
          direction: 'to_home',
          throughSequence: ack.throughSequence
        })
      }
      return { acknowledged: params.acknowledgments.length }
    }
  })
]
