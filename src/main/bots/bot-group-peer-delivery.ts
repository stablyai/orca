import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { RemoteComputerRefusal, refusedAsk } from './bot-group-remote-refusal'
import type { BotGroupMessage, BotGroupRemoteAsk } from '../../shared/bots/bot-group'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import {
  activeGroupRemoteMember,
  activeGroupSpeaker,
  groupRouteRoot,
  groupSpeakerLabel
} from './bot-group-route-scope'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import {
  deliverPeerMail,
  peerMailPairing,
  type PeerMailServer
} from '../runtime/orchestration/federation/peer-mail/peer-mail-delivery'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import type { BotGroupRuntime } from './bot-group-runtime'
import type { PendingGroupRemoteDelivery } from './bot-group-route-queue'
import { remoteQuestionSummary } from './bot-group-remote-question'
import { requireRemoteComputer } from './bot-group-remote'

/** Asks whose mail is being handed to their computer now, by request id. */
const sending = new Set<string>()

/** Whether this ask's mail is being handed over now; one stored as sending that is not may or may
 *  not have reached its computer. */
export function isRemoteAskInFlight(requestId: string): boolean {
  return sending.has(requestId)
}

// Refusals the other computer sends before it takes a request in. Its routing refusals reach this
// computer as a generic runtime error, which could also follow admission, so those read as unknown.
const REFUSED_BEFORE_ADMISSION = new Set([
  'bot_not_found',
  'bot_chat_not_found',
  'invalid_argument',
  'request_mismatch'
])

/** The reservation is durable until claimed; after a claim, a lost acknowledgement is unknown. */
export async function deliverRemoteAsks(
  groups: BotGroupRuntime,
  message: BotGroupMessage
): Promise<void> {
  const queued = groups.store.routes
    .pendingRemoteDeliveries(message.groupId, message.id)
    .filter(({ id }) => !sending.has(id))
  for (const { id } of queued) {
    sending.add(id)
  }
  const computers = new Map<string, Promise<PeerMailServer>>()
  const serverFor = (environmentId: string) => {
    const server = computers.get(environmentId) ?? requireRemoteComputer(groups, environmentId)
    computers.set(environmentId, server)
    return server
  }
  await Promise.all(
    queued.map(async (delivery) => {
      try {
        await deliverRoomMail(groups, message, delivery, serverFor)
      } catch (error) {
        console.warn('[bot-groups] could not finish remote group mail', error)
      } finally {
        sending.delete(delivery.id)
        groups.changed(message.groupId)
      }
    })
  )
}

async function deliverRoomMail(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  { id, body, isAnswer }: PendingGroupRemoteDelivery,
  serverFor: (environmentId: string) => Promise<PeerMailServer>
): Promise<void> {
  const asker = message.groupRequest?.from
  const ask = isAnswer
    ? undefined
    : message.remoteAsks?.find((candidate) => candidate.requestId === id)
  const target = isAnswer ? (asker?.kind === 'remote' ? asker.member : undefined) : ask
  if (!target) {
    groups.store.routes.claimRemoteDelivery(id)
    return
  }
  const { environmentId } = target
  try {
    const server = await serverFor(environmentId)
    const db = groups.runtime.getOrchestrationDb()
    const pairing = peerMailPairing(server)
    const machine = groups.runtime.readMachineName()
    const pending = await runKeyedSerializedOperation(groups.queues, message.groupId, async () => {
      const current = groups.store.message(message.id)
      if (!current || !groups.store.routes.claimRemoteDelivery(id)) {
        return {}
      }
      const root = groupRouteRoot(groups, current)
      const room = groups.store.room(current.groupId, current.threadId)
      if (
        !root ||
        !activeGroupRemoteMember(room, root, target) ||
        (asker && !activeGroupSpeaker(groups, room, root, asker))
      ) {
        return { stopped: true }
      }
      if (target.pairing && target.pairing !== pairing) {
        throw new OrchestrationError(
          'request_mismatch',
          'The pairing for this group member changed. Remove and re-add the member before asking it.',
          { effectsApplied: false }
        )
      }
      if (asker && !server.takesGroupConversation) {
        throw new OrchestrationError(
          'server_mail_unsupported',
          'Update Orca on this group member’s computer for bot-to-bot group conversations.',
          { effectsApplied: false }
        )
      }
      const groupName = room.name
      const roomAddress = botGroupRoomMailAddress(room.id)
      if (isAnswer && asker?.kind === 'remote') {
        const conversation = db.getPeerMailConversation(asker.conversationId)
        const remoteSpeaker = current.remoteAsks?.[0]
        const localSpeaker = current.turns[0]
        const sourceName = remoteSpeaker?.name ?? localSpeaker?.botName
        const sourceBot = remoteSpeaker
          ? { id: remoteSpeaker.botId, name: remoteSpeaker.name, avatar: null }
          : localSpeaker && { id: localSpeaker.botId, name: localSpeaker.botName, avatar: null }
        if (
          !sourceName ||
          !isOrcaSessionId(target.chatSessionId) ||
          conversation?.role !== 'home' ||
          conversation.environment_id !== environmentId ||
          conversation.peer_fingerprint !== pairing ||
          conversation.local_party !== roomAddress ||
          (remoteSpeaker && !activeGroupRemoteMember(room, root, remoteSpeaker)) ||
          (localSpeaker &&
            !activeGroupSpeaker(groups, room, root, {
              ...localSpeaker,
              name: localSpeaker.botName,
              kind: 'local'
            }))
        ) {
          return {}
        }
        return {
          sent: deliverPeerMail(groups.runtime, server, conversation, {
            id,
            to: formatOrcaSessionAddress(target.chatSessionId),
            subject: `Answer in ${groupName} from ${sourceName}`,
            senderLabel: `${sourceName} in ${groupName} on ${machine}`,
            body,
            threadId: asker.requestId,
            group: { kind: 'answer', requestId: asker.requestId },
            sender: { name: sourceName, computer: machine, bot: sourceBot }
          })
        }
      }
      if (!ask) {
        return {}
      }
      const conversation = db.openHomePeerMailConversation({
        environmentId,
        peerFingerprint: pairing,
        localParty: roomAddress,
        localPaneKey: null
      })
      groups.store.update({
        ...current,
        remoteAsks: current.remoteAsks?.map((candidate) =>
          candidate.requestId === id
            ? {
                ...candidate,
                conversationId: conversation.conversation_id,
                ...(server.takesGroupConversation ? { interactive: true as const } : {})
              }
            : candidate
        )
      })
      const sourceName = asker ? groupSpeakerLabel(asker).name : groupName
      const sourceBot = asker
        ? {
            id: asker.kind === 'remote' ? asker.member.botId : asker.botId,
            name: sourceName,
            avatar: null
          }
        : undefined
      return {
        sent: deliverPeerMail(groups.runtime, server, conversation, {
          id,
          to: `bot:${ask.botId}`,
          chat: ask.chatSessionId,
          senderLabel: `${asker ? `${sourceName} in ` : ''}${groupName} on ${machine}`,
          subject: `In ${groupName}: ${remoteQuestionSummary(current)}`,
          body: server.takesGroupConversation
            ? `${body}\n\nAnswer this question once with \`orca orchestration reply --id ${id} --body <text>\`. An explicit @Name in the answer asks that group member to take a turn. To post something new after your answer, use \`orca orchestration group-post --id ${id} --body <text>\`; the group host will route any @Name on that post.`
            : body,
          type: 'question',
          ...(server.takesGroupConversation
            ? {
                group: {
                  kind: 'question' as const,
                  botId: ask.botId,
                  roomId: room.id,
                  rootRequestId: root.id,
                  threadId: root.threadId
                }
              }
            : {}),
          sender: { name: sourceName, computer: machine, bot: sourceBot }
        })
      }
    })
    if (pending.sent) {
      groups.runtime.ensureOrchestrationPeerMailRelay(environmentId)
      await pending.sent
      if (ask) {
        await settleAsk(groups, message, id, { state: 'sent' })
      }
    } else if (ask && pending.stopped) {
      await settleAsk(groups, message, id, { state: 'failed' })
    }
  } catch (error) {
    groups.store.routes.claimRemoteDelivery(id)
    if (ask) {
      await settleAsk(groups, message, id, {
        state:
          refusedBeforeAdmission(error) ||
          error instanceof RemoteComputerRefusal ||
          error instanceof BotFailureError
            ? 'failed'
            : 'unknown',
        ...refusedAsk(error)
      })
    } else {
      console.warn('[bot-groups] group answer could not be delivered', error)
    }
  }
}

function refusedBeforeAdmission(error: unknown): boolean {
  if (!(error instanceof OrchestrationError)) {
    return false
  }
  const data: unknown = error.data
  const effectsApplied =
    typeof data === 'object' && data !== null && 'effectsApplied' in data
      ? data.effectsApplied
      : undefined
  return effectsApplied === false || REFUSED_BEFORE_ADMISSION.has(error.code)
}

/** Writes one ask's delivery outcome on the current post, in the room's queue. It never replaces
 *  an answer or notice already in; a late answer still replaces it. */
async function settleAsk(
  groups: BotGroupRuntime,
  message: Pick<BotGroupMessage, 'id' | 'groupId'>,
  requestId: string,
  outcome: Pick<BotGroupRemoteAsk, 'state' | 'error' | 'failure'>
): Promise<void> {
  await runKeyedSerializedOperation(groups.queues, message.groupId, async () => {
    const current = groups.store.message(message.id)
    if (!current?.remoteAsks?.some((ask) => ask.requestId === requestId)) {
      return
    }
    groups.store.update({
      ...current,
      remoteAsks: current.remoteAsks.map((ask) =>
        ask.requestId === requestId && !ask.reply
          ? { ...(outcome.error ? newError(ask, outcome) : ask), state: outcome.state }
          : ask
      )
    })
  })
}

/** An ask with the outcome's error in place of its own, and the code only that error has. */
function newError(
  ask: BotGroupRemoteAsk,
  { error, failure }: Pick<BotGroupRemoteAsk, 'error' | 'failure'>
): BotGroupRemoteAsk {
  const { failure: _previous, ...rest } = ask
  return { ...rest, error, ...(failure ? { failure } : {}) }
}
