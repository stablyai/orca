// A room member's chat is started on the agent its bot was on when the room was made. Switching the
// bot's agent leaves that chat on the old agent, and the old agent keeps sending the old provider's
// model, so a room post comes back "Unknown model ID". Rebuild each room's member on the bot's agent.
import { randomUUID } from 'node:crypto'
import type { Bot, BotAgent } from '../../shared/bot-types'
import type { BotGroup, BotGroupMember } from '../../shared/bots/bot-group'
import { botGroupRoom, indexBotGroupJournal } from '../../shared/bots/bot-group'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { closeMemberChat } from './bot-mail-chat'
import { requireStructuredHost, startBotSession } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The room a member chat talks in, as the store holds it now. */
type Room = { groupId: string; threadId: string | undefined }

/**
 * Rebuilds each of `bot`'s room member chats after its agent changed: one new chat per room on its
 * current agent and launch, swapped in where the old one was. A bot in no room starts no chat and
 * closes none. Other members keep their chats and their turns; a room's history survives the swap,
 * since a turn keeps the operation and worker ids it ran under.
 */
export async function rebuildGroupMembersForAgent(
  groups: BotGroupRuntime,
  bot: Bot,
  previousAgent: BotAgent
): Promise<void> {
  if (previousAgent === bot.agent) {
    return
  }
  const rooms = roomsNeedingAgent(groups, bot.id)
  if (rooms.length === 0) {
    return
  }
  const started: { room: Room; member: BotGroupMember }[] = []
  try {
    for (const room of rooms) {
      await runKeyedSerializedOperation(groups.queues, room.groupId, async () => {
        started.push({
          room,
          member: {
            botId: bot.id,
            sessionId: await startBotSession(groups.runtime, bot, {
              sessionId: `bot-group-member-${randomUUID()}`,
              background: true
            })
          }
        })
      })
    }
    for (const { room, member } of started) {
      await swapBotGroupMember(groups, room.groupId, room.threadId, member)
    }
  } catch (error) {
    await Promise.allSettled(started.map(({ member }) => closeMemberChat(groups.runtime, member)))
    throw error
  }
}

/** Every room whose current members include `botId`, the original room first. */
export function roomsNeedingAgent(groups: BotGroupRuntime, botId: string): Room[] {
  return groups.store
    .list()
    .flatMap((group) =>
      [undefined, ...(group.threads ?? []).map((thread) => thread.id)]
        .filter((threadId) =>
          botGroupRoom(group, threadId).members.some((member) => member.botId === botId)
        )
        .map((threadId) => ({ groupId: group.id, threadId }))
    )
}

/** `previous` with `botId`'s member in one room replaced by `member`: the old session joins the
 *  room's former ones, and no other member, thread or record changes. */
export function withSwappedBotGroupMember(
  previous: BotGroup,
  threadId: string | undefined,
  botId: string,
  member: BotGroupMember
): BotGroup {
  const swap = <T extends Pick<BotGroup, 'members' | 'formerSessionIds'>>(room: T): T => {
    const replaced = room.members.find((entry) => entry.botId === botId)
    if (!replaced || replaced.sessionId === member.sessionId) {
      return room
    }
    return {
      ...room,
      members: room.members.map((entry) =>
        entry.sessionId === replaced.sessionId ? member : entry
      ),
      formerSessionIds: [...(room.formerSessionIds ?? []), replaced.sessionId]
    }
  }
  return threadId === undefined
    ? { ...previous, ...swap(previous), revision: previous.revision + 1 }
    : {
        ...previous,
        threads: previous.threads?.map((thread) =>
          thread.id === threadId ? swap(thread) : thread
        ),
        revision: previous.revision + 1
      }
}

/** Replaces a bot's member in one room with the chat it now runs on, as a membership change does:
 *  the old chat's turns are frozen as they stood, its pending send goes, and the room remembers the
 *  session so its history rows still open. Other members and the room's other records are untouched. */
export async function swapBotGroupMember(
  groups: BotGroupRuntime,
  groupId: string,
  threadId: string | undefined,
  member: BotGroupMember
): Promise<void> {
  await runKeyedSerializedOperation(groups.queues, groupId, async () => {
    const previous = groups.store.get(groupId)
    const replaced = botGroupRoom(previous, threadId).members.find(
      (entry) => entry.botId === member.botId
    )
    if (!replaced || replaced.sessionId === member.sessionId) {
      return
    }
    const next = withSwappedBotGroupMember(previous, threadId, member.botId, member)
    const leaving = replaced.sessionId
    const host = await requireStructuredHost(groups.runtime)
    const messages = groups.store.messages(groupId, Number.MAX_SAFE_INTEGER)
    const operationIds = messages.flatMap((message) =>
      message.turns.flatMap((turn) => (turn.sessionId === leaving ? [turn.operationId] : []))
    )
    const { snapshot } = await (await host.journalReads(leaving)).operationWindow({ operationIds })
    const frozen = indexBotGroupJournal(snapshot)
    groups.store.transaction(() => {
      groups.store.put(next)
      for (const message of groups.store.messages(groupId, Number.MAX_SAFE_INTEGER)) {
        const retired = message.turns.filter((turn) => turn.sessionId === leaving)
        if (retired.length === 0) {
          continue
        }
        // A retired turn is owed nothing more, so its pending send goes with it.
        groups.store.delivered(retired.map((turn) => turn.operationId))
        groups.store.update({
          ...message,
          turns: message.turns.map((turn) =>
            turn.sessionId === leaving
              ? {
                  ...turn,
                  revoked: true,
                  frozenItems: frozen(turn.operationId, turn.workerDispatchIds)
                }
              : turn
          )
        })
      }
    })
    await Promise.allSettled([closeMemberChat(groups.runtime, replaced)])
    groups.changed(groupId)
  })
}
