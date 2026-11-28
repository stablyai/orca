import type { BotGroupTranscript } from '../../shared/bots/bot-group-transcript'
import { collectRemoteAnswers, presentPageAnswers } from './bot-group-remote-answers'
import { presentBotGroupPage, projectBotGroupRoomPost } from './bot-group-page-replies'
import { settleDeadGroupMailTurns } from './bot-group-dead-mail-turns'
import type { BotGroupRuntime } from './bot-group-runtime'
import { orchestrationReader } from '../runtime/orchestration/db/reader-worker/orchestration-reader-client'

/** One room's latest page; its `group` carries that room's member sessions. */
export async function readBotGroup(
  groups: BotGroupRuntime,
  groupId: string,
  beforeSequence?: number,
  threadId?: string,
  knownReplyKeys?: readonly string[],
  updatedPostIds?: readonly string[],
  updatesOnly?: true,
  signal?: AbortSignal
): Promise<BotGroupTranscript> {
  const group = groups.store.room(groupId, threadId)
  const readPage = async (limit: number) => {
    const result = await orchestrationReader().read(
      groups.store,
      'botGroupPosts',
      { kind: 'page', groupId, threadId, limit, beforeSequence },
      signal
    )
    signal?.throwIfAborted()
    if (result.kind !== 'page') {
      throw new Error('The room reader returned a post for a page request.')
    }
    return result.messages
  }
  if (knownReplyKeys === undefined) {
    const stored = await readPage(41)
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
  const stored = updatesOnly ? [] : await readPage(41)
  const recent = stored.slice(-40)
  const recentIds = new Set(recent.map(({ id }) => id))
  const updates = (
    await Promise.all(
      [...new Set(updatedPostIds)].map(async (id) => {
        if (recentIds.has(id)) {
          return null
        }
        const result = await orchestrationReader().read(
          groups.store,
          'botGroupPosts',
          { kind: 'post', id },
          signal
        )
        signal?.throwIfAborted()
        if (result.kind !== 'post') {
          throw new Error('The room reader returned a page for a post request.')
        }
        const post = result.message
        return post?.groupId === groupId && post.threadId === threadId ? post : null
      })
    )
  ).flatMap((post) => {
    if (!post) {
      return []
    }
    return [post]
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
