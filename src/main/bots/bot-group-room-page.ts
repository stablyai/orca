import type { BotGroupTranscript } from '../../shared/bots/bot-group-transcript'
import { collectRemoteAnswers, presentPageAnswers } from './bot-group-remote-answers'
import { presentBotGroupPage, projectBotGroupRoomPost } from './bot-group-page-replies'
import { settleDeadGroupMailTurns } from './bot-group-dead-mail-turns'
import type { BotGroupRuntime } from './bot-group-runtime'

/** One room's latest page; its `group` carries that room's member sessions. */
export function readBotGroup(
  groups: BotGroupRuntime,
  groupId: string,
  beforeSequence?: number,
  threadId?: string,
  knownReplyKeys?: readonly string[],
  updatedPostIds?: readonly string[],
  updatesOnly?: true
): BotGroupTranscript {
  const group = groups.store.room(groupId, threadId)
  if (knownReplyKeys === undefined) {
    const stored = groups.store.roomMessages(groupId, threadId, 41, beforeSequence)
    const messages = collectRemoteAnswers(groups, stored.slice(-40))
    settleDeadGroupMailTurns(groups, messages)
    return {
      group,
      messages: presentPageAnswers(messages).map((message) => ({
        ...message,
        turns: message.turns.map(
          ({
            reply: _reply,
            end: _end,
            workedMs: _workedMs,
            endedAt: _endedAt,
            turnItemId: _turnItemId,
            hadWork: _hadWork,
            roomReply: _roomReply,
            ...turn
          }) => turn
        )
      })),
      hasEarlier: stored.length > messages.length
    }
  }
  const stored = updatesOnly
    ? []
    : groups.store.roomPageMessages(groupId, threadId, 41, beforeSequence)
  const recent = stored.slice(-40)
  const recentIds = new Set(recent.map(({ id }) => id))
  const updates = [...new Set(updatedPostIds)].flatMap((id) => {
    if (recentIds.has(id)) {
      return []
    }
    const post = groups.store.roomPageMessage(id)
    return post?.groupId === groupId && post.threadId === threadId ? [post] : []
  })
  // Admission runs backward. Give the requested page first claim on the transport.
  const candidates = [...updates.sort((left, right) => left.sequence - right.sequence), ...recent]
  const messages = collectRemoteAnswers(groups, candidates).map((post, index) =>
    post === candidates[index] ? post : projectBotGroupRoomPost(post)
  )
  settleDeadGroupMailTurns(groups, messages)
  const answers = presentPageAnswers(messages)
  // An updates-only read has its own budget and must advance even if one post needs a cut.
  const page = presentBotGroupPage(
    group,
    answers,
    knownReplyKeys,
    updatesOnly ? new Set(updates.map(({ id }) => id)) : recentIds
  )
  const current = page.filter(({ id }) => recentIds.has(id))
  const updatedPosts = page.filter(({ id }) => !recentIds.has(id))
  const admittedUpdates = new Set(updatedPosts.map(({ id }) => id))
  const deferredPostIds = updates.flatMap(({ id }) => (admittedUpdates.has(id) ? [] : [id]))
  return {
    group,
    // An ended turn draws from its saved reply and end, so the room needs none of its chat's rows.
    messages: current,
    ...(updatedPosts.length > 0 ? { updatedPosts } : {}),
    ...(deferredPostIds.length > 0 ? { deferredPostIds } : {}),
    hasEarlier: stored.length > current.length
  }
}
