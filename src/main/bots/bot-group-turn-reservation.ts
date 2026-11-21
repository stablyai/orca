import { botGroupContext, type BotGroup, type BotGroupTurn } from '../../shared/bots/bot-group'
import type { Bot } from '../../shared/bot-types'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { completedGroupReplies } from './bot-group-completed-replies'
import type { BotGroupRuntime } from './bot-group-runtime'

/** One turn per bot in `botIds` that is a member, each with the room history its session has not
 *  seen, owed until native admission. */
export async function reserveGroupTurns(
  groups: BotGroupRuntime,
  group: BotGroup,
  threadId: string | undefined,
  bots: readonly Bot[],
  botIds: readonly string[]
): Promise<{ turns: BotGroupTurn[]; contexts: Map<string, string> }> {
  const history = groups.store.roomMessages(group.id, threadId, 40)
  const completed = await completedGroupReplies(groups, history)
  const contexts = new Map<string, string>()
  const turns = botIds.flatMap((botId) => {
    const bot = bots.find((bot) => bot.id === botId)
    const member = group.members.find((member) => member.botId === botId)
    if (!bot || !member) {
      return []
    }
    const operationId = mintAgentSessionOperationId(Date.now())
    contexts.set(operationId, botGroupContext(history, completed, member))
    const { name: botName, avatar, avatarColor, agent } = bot
    return [
      {
        operationId,
        botId,
        botName,
        avatar,
        ...(avatarColor ? { avatarColor } : {}),
        agent,
        sessionId: member.sessionId
      }
    ]
  })
  return { turns, contexts }
}
