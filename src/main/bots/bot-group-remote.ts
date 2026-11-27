import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { RemoteComputerRefusal, refusedAsk } from './bot-group-remote-refusal'
import type { z } from 'zod'
import {
  botGroupRemoteKey,
  type BotGroup,
  type BotGroupCreate,
  type BotGroupMessage,
  type BotGroupRemoteAsk,
  type BotGroupRemoteMember
} from '../../shared/bots/bot-group'
import type { Bot } from '../../shared/bot-types'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import {
  deliverPeerMail,
  peerMailPairing,
  requirePeerMailServer
} from '../runtime/orchestration/federation/peer-mail/peer-mail-delivery'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import type { BotGroupRuntime } from './bot-group-runtime'
import { remoteQuestionSummary } from './bot-group-remote-question'
import { isRemoteServerUnreachable } from '../runtime/orchestration/federation/remote-owned/remote-server-unreachable'

type RemoteBots = NonNullable<z.infer<typeof BotGroupCreate>['remoteBots']>

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

/** The computers a requested roster newly reaches, checked before the room's queue so a slow or
 *  offline computer never holds the room's posts and Stop: each one's name, by environment. */
export async function checkRemoteComputers(
  groups: BotGroupRuntime,
  { remoteBots: requested, groupId }: { remoteBots?: RemoteBots; groupId?: string }
): Promise<Map<string, string>> {
  const group = groupId === undefined ? undefined : groups.store.get(groupId)
  const kept = new Set((group?.remoteMembers ?? []).map(botGroupRemoteKey))
  const computers = new Map<string, string>()
  for (const environmentId of new Set(
    (requested ?? [])
      .filter((bot) => !kept.has(botGroupRemoteKey(bot)))
      .map((bot) => bot.environmentId)
  )) {
    computers.set(environmentId, (await requireRemoteComputer(groups, environmentId)).name)
  }
  return computers
}

/**
 * The remote roster a create or edit saves: a room on this computer, at least one of its own bots,
 * and a joining member whose name no other member has, so mentions stay unambiguous (members who
 * already share a name, say after a rename, never block an edit). A member who joins now has seen
 * the room up to its newest post.
 */
export function resolveRemoteMembers(
  groups: BotGroupRuntime,
  localBots: readonly Bot[],
  /** The whole remote roster asked for; absent keeps the group's. */
  { remoteBots: requested }: { remoteBots?: RemoteBots },
  /** The group being edited, as its queue holds it now. */
  group: BotGroup | undefined,
  /** From `checkRemoteComputers`, for the members this edit adds. */
  computers: ReadonlyMap<string, string>
): BotGroupRemoteMember[] {
  const remoteBots: RemoteBots | readonly BotGroupRemoteMember[] =
    requested ?? group?.remoteMembers ?? []
  if (remoteBots.length === 0) {
    return []
  }
  if (localBots.length === 0) {
    throw new BotFailureError('groupNeedsLocalBot')
  }
  const keys = new Set(remoteBots.map(botGroupRemoteKey))
  if (keys.size !== remoteBots.length) {
    throw new BotFailureError('groupBotTwice')
  }
  const kept = new Map(
    (group?.remoteMembers ?? []).map((member) => [botGroupRemoteKey(member), member])
  )
  const wasLocal = new Set(group?.members.map((member) => member.botId))
  const named = [
    ...localBots.map((bot) => ({ name: bot.name, joining: !wasLocal.has(bot.id) })),
    // A kept member is mentioned by the name it joined with, whatever its computer calls it now.
    ...remoteBots.map((bot) => {
      const member = kept.get(botGroupRemoteKey(bot))
      return { name: member?.name ?? bot.name, joining: !member }
    })
  ]
  for (const [index, member] of named.entries()) {
    const folded = member.name.toLocaleLowerCase()
    if (
      member.joining &&
      named.some(
        // The later of two joining namesakes is the one refused.
        (other, at) =>
          at !== index &&
          (at < index || !other.joining) &&
          other.name.toLocaleLowerCase() === folded
      )
    ) {
      throw new BotFailureError('groupNameTaken', { name: member.name })
    }
  }
  const joinedAfter = group ? newestGroupSequence(groups, group) : 0
  return remoteBots.map((bot) => {
    const member = kept.get(botGroupRemoteKey(bot))
    if (member) {
      return member
    }
    const computer = computers.get(bot.environmentId)
    if (!computer) {
      throw new BotFailureError('groupChanged')
    }
    return {
      environmentId: bot.environmentId,
      botId: bot.botId,
      chatSessionId: bot.chatSessionId,
      computer,
      joinedAfter,
      name: bot.name,
      avatar: bot.avatar,
      ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}),
      ...(bot.avatarOutfit ? { avatarOutfit: bot.avatarOutfit } : {}),
      agent: bot.agent
    }
  })
}

/** A new group's remote roster, its computers checked first. */
export async function resolveNewGroupRemoteMembers(
  groups: BotGroupRuntime,
  localBots: readonly Bot[],
  input: { remoteBots?: RemoteBots }
): Promise<BotGroupRemoteMember[]> {
  const computers = await checkRemoteComputers(groups, input)
  return resolveRemoteMembers(groups, localBots, input, undefined, computers)
}

/** The paired computer, refused with the group's own words when its Orca can't take bot questions. */
async function requireRemoteComputer(groups: BotGroupRuntime, environmentId: string) {
  let name = environmentId
  try {
    name = (await groups.runtime.resolveOrchestrationWorkerServer(environmentId)).name
    return await requirePeerMailServer(groups.runtime, environmentId, true, 'question')
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'server_mail_unsupported') {
      throw new BotFailureError('groupPeerTooOld', { host: name })
    }
    // Only no answer at all may clear by itself; an unpaired computer or a refusal won't.
    throw new RemoteComputerRefusal(name, text(error), isRemoteServerUnreachable(error))
  }
}

/**
 * Hands a new post's remote questions to their computers, after the room queue has let go: each is
 * the owner's own question, to the chat the bot had as its Home Chat when it joined (never another
 * bot by name). A refusal before admission is `failed`; anything else that went wrong is `unknown`,
 * since that computer may have taken it. Nothing is retried or resent.
 */
export async function deliverRemoteAsks(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  /** The words of each ask of a post this call stored; null for a replayed send. */
  bodies: ReadonlyMap<string, string> | null
): Promise<void> {
  const asks = (message.remoteAsks ?? []).filter(
    (ask) => ask.state === 'sending' && bodies?.has(ask.requestId) && !sending.has(ask.requestId)
  )
  if (asks.length === 0) {
    return
  }
  for (const ask of asks) {
    sending.add(ask.requestId)
  }
  try {
    const group = groups.store.get(message.groupId)
    const machine = groups.runtime.readMachineName()
    await Promise.all(
      [...Map.groupBy(asks, (ask) => ask.environmentId)].map(
        async ([environmentId, computerAsks]) => {
          let server: Awaited<ReturnType<typeof requireRemoteComputer>>
          try {
            server = await requireRemoteComputer(groups, environmentId)
          } catch (error) {
            const refused = refusedAsk(error)
            for (const ask of computerAsks) {
              await settleAsk(groups, message, ask.requestId, { state: 'failed', ...refused })
            }
            return
          }
          const conversation = groups.runtime.getOrchestrationDb().openHomePeerMailConversation({
            environmentId: server.environmentId,
            peerFingerprint: peerMailPairing(server),
            localParty: botGroupRoomMailAddress(message.groupId),
            localPaneKey: null
          })
          try {
            for (const ask of computerAsks) {
              try {
                await deliverPeerMail(groups.runtime, server, conversation, {
                  id: ask.requestId,
                  to: `bot:${ask.botId}`,
                  chat: ask.chatSessionId,
                  senderLabel: `${group.name} on ${machine}`,
                  subject: `In ${group.name}: ${remoteQuestionSummary(message)}`,
                  body: bodies?.get(ask.requestId),
                  type: 'question',
                  sender: { name: group.name, computer: machine }
                })
                await settleAsk(groups, message, ask.requestId, { state: 'sent' })
              } catch (error) {
                await settleAsk(groups, message, ask.requestId, {
                  state: refusedBeforeAdmission(error) ? 'failed' : 'unknown',
                  error: text(error)
                })
              }
            }
          } finally {
            // Its answers come back on this conversation, even when only the acknowledgement was lost.
            groups.runtime.ensureOrchestrationPeerMailRelay(server.environmentId)
          }
        }
      )
    )
  } finally {
    for (const ask of asks) {
      sending.delete(ask.requestId)
    }
    groups.changed(message.groupId)
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

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** The room's newest post across all its threads: a member joining now has seen up to here. */
export function newestGroupSequence(groups: BotGroupRuntime, group: BotGroup): number {
  return Math.max(
    0,
    ...[undefined, ...(group.threads ?? []).map((thread) => thread.id)].map(
      (threadId) => groups.store.roomMessages(group.id, threadId, 1)[0]?.sequence ?? 0
    )
  )
}
