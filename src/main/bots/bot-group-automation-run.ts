// An automation that runs in a group room: each run is a post served as its owner's, which the
// automation's member answers, so the room's hand-offs, peer mail and Stop attach to it.
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { botGroupMessageSummary } from './bot-group-attachments'
import type { BotRunFields } from './bot-chat-session'
import { deliverTurn } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'
import { reserveGroupTurns } from './bot-group-turn-reservation'
import type { BotRunSend } from './bot-run-turn-watch'

export function botLeftGroupRoom(botName: string): string {
  return `${botName} is no longer a member of that group room, so the automation can't run there. Edit it to run somewhere else.`
}

/** The room `sessionId` is the bot's member session of, titled with the room's name; null when it isn't. */
export function botGroupRoomChat(
  groups: BotGroupRuntime,
  bot: Pick<Bot, 'id'>,
  sessionId: string
): { title: string; sessionId: string } | null {
  const found = groups.store.memberOf(sessionId)
  if (found?.member.botId !== bot.id) {
    return null
  }
  const thread = found.threadId
    ? found.group.threads?.find((entry) => entry.id === found.threadId)
    : undefined
  return { title: thread?.title ?? found.group.name, sessionId }
}

/** Posts the run's prompt in the room `sessionId` belongs to and starts its member's turn on it;
 *  throws when the bot left the room or its session refused the turn. */
export async function sendBotGroupAutomationRun(
  groups: BotGroupRuntime,
  bot: Bot,
  sessionId: string,
  text: string,
  run?: BotRunFields
): Promise<BotRunSend> {
  const message = await runKeyedSerializedOperation(
    groups.queues,
    groupOf(groups, bot, sessionId),
    async () => {
      const found = groups.store.memberOf(sessionId)
      if (found?.member.botId !== bot.id) {
        throw new Error(botLeftGroupRoom(bot.name))
      }
      if (bot.paused) {
        throw new Error(
          `${bot.name} is paused, so the automation didn't run. Resume it to run again.`
        )
      }
      const { group: room, threadId } = found
      const { turns, contexts } = await reserveGroupTurns(
        groups,
        room,
        threadId,
        groups.runtime.bots.list(),
        [bot.id]
      )
      const stored = groups.store.append(
        {
          id: randomUUID(),
          groupId: room.id,
          ...(threadId ? { threadId } : {}),
          author: { kind: 'owner' },
          text,
          createdAt: Date.now(),
          ...(run?.automationRun ? { automationRun: run.automationRun } : {}),
          ...(run?.memorySource ? { memorySource: run.memorySource } : {}),
          ...(run?.memorySource && run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
          turns
        },
        contexts
      )
      groups.store.setLatest(
        room.id,
        { authorName: null, text: botGroupMessageSummary(stored), at: stored.createdAt },
        { post: stored.sequence }
      )
      return stored
    }
  )
  groups.changed(message.groupId)
  const [turn] = message.turns
  const fingerprint = turn ? await deliverTurn(groups, message, turn, run) : undefined
  if (!turn || fingerprint === undefined) {
    throw new Error(turnError(groups, message) ?? botLeftGroupRoom(bot.name))
  }
  return { sessionId, clientMessageId: turn.operationId, fingerprint }
}

function groupOf(groups: BotGroupRuntime, bot: Bot, sessionId: string): string {
  const found = groups.store.memberOf(sessionId)
  if (found?.member.botId !== bot.id) {
    throw new Error(botLeftGroupRoom(bot.name))
  }
  return found.group.id
}

function turnError(groups: BotGroupRuntime, message: BotGroupMessage): string | undefined {
  return groups.store.message(message.id)?.turns[0]?.error
}
