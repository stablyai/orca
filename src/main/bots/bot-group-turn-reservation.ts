import {
  botGroupContext,
  type BotGroup,
  type BotGroupMessage,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import type { Bot } from '../../shared/bot-types'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { completedGroupReplies } from './bot-group-completed-replies'
import type { BotGroupRuntime } from './bot-group-runtime'
import { collectRemoteAnswers } from './bot-group-remote-answers'

/** One turn per bot in `botIds` that is a member, each with the room history its session has not
 *  seen (remote members' answers included), owed until native admission; and that history. */
export async function reserveGroupTurns(
  groups: BotGroupRuntime,
  group: BotGroup,
  threadId: string | undefined,
  bots: readonly Bot[],
  botIds: readonly string[]
): Promise<{
  turns: BotGroupTurn[]
  contexts: Map<string, string>
  history: BotGroupMessage[]
  completed: Awaited<ReturnType<typeof completedGroupReplies>>
}> {
  const page = groups.store.roomMessages(group.id, threadId, 40)
  const completed = await completedGroupReplies(groups, page)
  // Remote answers are merged after that read, so one that arrived during it is in this context.
  const history = collectRemoteAnswers(groups, page)
  const contexts = new Map<string, string>()
  const turns = botIds.flatMap((botId) => {
    const bot = bots.find((bot) => bot.id === botId)
    const member = group.members.find((member) => member.botId === botId)
    if (!bot || !member) {
      return []
    }
    const operationId = mintAgentSessionOperationId(Date.now())
    contexts.set(operationId, botGroupContext(history, completed, member))
    const { name: botName, avatar, avatarColor, avatarOutfit, agent } = bot
    return [
      {
        operationId,
        botId,
        botName,
        avatar,
        ...(avatarColor ? { avatarColor } : {}),
        ...(avatarOutfit ? { avatarOutfit } : {}),
        agent,
        sessionId: member.sessionId
      }
    ]
  })
  return { turns, contexts, history, completed }
}
