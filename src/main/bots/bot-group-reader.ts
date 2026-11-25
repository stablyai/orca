import type { BotGroupRuntime } from './bot-group-runtime'
import { settleDeadGroupMailTurns } from './bot-group-dead-mail-turns'
import { collectRemoteAnswers, presentPageAnswers } from './bot-group-remote-answers'
/** One room's latest page; its `group` carries that room's member sessions. */
export function readBotGroup(
  groups: BotGroupRuntime,
  groupId: string,
  beforeSequence?: number,
  threadId?: string
) {
  const group = groups.store.room(groupId, threadId)
  const messages = collectRemoteAnswers(
    groups,
    groups.store.roomMessages(groupId, threadId, 40, beforeSequence)
  )
  settleDeadGroupMailTurns(groups, messages)
  return {
    group,
    // Saved replies feed later posts' context only; the room renders each turn from its chat.
    messages: presentPageAnswers(messages).map((message) => ({
      ...message,
      turns: message.turns.map(({ reply: _reply, ...turn }) => turn)
    })),
    hasEarlier:
      messages.length > 0 &&
      groups.store.roomMessages(groupId, threadId, 1, messages[0].sequence).length > 0
  }
}
