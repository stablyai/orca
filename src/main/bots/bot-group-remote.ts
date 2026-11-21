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

/**
 * The remote roster a create or edit asks for, checked before anything is saved: a room on this
 * computer, at least one of its own bots, names that keep mentions unambiguous, and computers whose
 * Orca takes questions for their bots. A member who joins now sees the room's history to this point.
 */
export async function resolveRemoteMembers(
  groups: BotGroupRuntime,
  localBots: readonly Bot[],
  /** The whole remote roster asked for; absent keeps the group's. */
  requested: RemoteBots | undefined,
  /** The group being edited: its members' computers were checked when they joined. */
  group?: BotGroup
): Promise<BotGroupRemoteMember[]> {
  const remoteBots: RemoteBots | readonly BotGroupRemoteMember[] =
    requested ?? group?.remoteMembers ?? []
  if (remoteBots.length === 0) {
    return []
  }
  if (localBots.length === 0) {
    throw new Error('This group needs at least one bot on this computer.')
  }
  const keys = new Set(remoteBots.map(botGroupRemoteKey))
  if (keys.size !== remoteBots.length) {
    throw new Error('Choose each bot once.')
  }
  const names = new Set<string>()
  for (const { name } of [...localBots, ...remoteBots]) {
    const folded = name.toLocaleLowerCase()
    if (names.has(folded)) {
      throw new Error(
        `${name} is already in this group. Members need different names so mentions stay unambiguous.`
      )
    }
    names.add(folded)
  }
  const kept = new Map(
    (group?.remoteMembers ?? []).map((member) => [botGroupRemoteKey(member), member])
  )
  // A member joining now has seen the room up to its newest post.
  const joinedAfter = group ? newestGroupSequence(groups, group) : 0
  const computers = new Map<string, string>()
  for (const environmentId of new Set(
    remoteBots.filter((bot) => !kept.has(botGroupRemoteKey(bot))).map((bot) => bot.environmentId)
  )) {
    computers.set(environmentId, (await requireRemoteComputer(groups, environmentId)).name)
  }
  return remoteBots.map(
    (bot) =>
      kept.get(botGroupRemoteKey(bot)) ?? {
        environmentId: bot.environmentId,
        botId: bot.botId,
        chatSessionId: bot.chatSessionId,
        computer: computers.get(bot.environmentId) ?? bot.environmentId,
        joinedAfter,
        name: bot.name,
        avatar: bot.avatar,
        ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}),
        agent: bot.agent
      }
  )
}

/** Asking bots on other computers is the owner's own act at this computer's window. */
export function assertRemotePoster(
  groups: BotGroupRuntime,
  group: Pick<BotGroup, 'remoteMembers'>,
  fromThisWindow: boolean
): void {
  if ((group.remoteMembers?.length ?? 0) > 0 && !fromThisWindow) {
    throw new Error(
      `To post in a group with bots on other computers, use ${groups.runtime.readMachineName()}.`
    )
  }
}

/** The paired computer, refused with the group's own words when its Orca can't take bot questions. */
async function requireRemoteComputer(groups: BotGroupRuntime, environmentId: string) {
  let name = environmentId
  try {
    name = (await groups.runtime.resolveOrchestrationWorkerServer(environmentId)).name
    return await requirePeerMailServer(groups.runtime, environmentId, true, 'question')
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'server_mail_unsupported') {
      throw new Error(`Update Orca on ${name} to add its bots to a group.`)
    }
    throw new Error(`Couldn't reach ${name}. ${text(error)}`.trim())
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
            for (const ask of computerAsks) {
              await settleAsk(groups, message, ask.requestId, {
                state: 'failed',
                error: text(error)
              })
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
    groups.changed()
  }
}

function refusedBeforeAdmission(error: unknown): boolean {
  if (!(error instanceof OrchestrationError)) {
    return false
  }
  const data = error.data as { effectsApplied?: unknown } | undefined
  return data?.effectsApplied === false || REFUSED_BEFORE_ADMISSION.has(error.code)
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
  outcome: Pick<BotGroupRemoteAsk, 'state' | 'error'>
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
          ? { ...ask, state: outcome.state, ...(outcome.error ? { error: outcome.error } : {}) }
          : ask
      )
    })
  })
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
