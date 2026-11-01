import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorSource, Notice, NoticeTarget, ThreadPlace } from './connector-adapter.js'
import { lockConnectorHost } from './connector-hosts.js'
import { applyOwnerAction, type AnswerablePrompt, type OwnerAction } from './owner-controls.js'
import type { QueueInTransaction } from './queue-delivery.js'
import type { ThreadPosts } from './thread-posts.js'

export const promptCardId = (externalId: string, promptId: string) =>
  `prompt:${externalId}:${promptId}`

// The conversation's prompt cards as a projection, beside its status and under the same lock: the
// shown prompt gets a card once; any other open card closes. A final card is never reopened. True
// when the shown prompt's card offers its buttons.
export async function refreshPromptCards(
  transaction: CloudDatabase,
  threadPosts: ThreadPosts,
  thread: { place: ThreadPlace; externalId: string },
  answerable: AnswerablePrompt | null
): Promise<boolean> {
  const { adapter, posts } = threadPosts
  const card = answerable && adapter.card(answerable)
  const prompt = card ? answerable : null
  const cards = await transaction.query(
    `SELECT post_id, body FROM connector_posts
     WHERE source = ? AND kind = 'status' AND post_id LIKE ?`,
    [adapter.source, `${promptCardId(thread.externalId, '')}%`]
  )
  const shownId = prompt ? promptCardId(thread.externalId, prompt.promptId) : null
  const shown = cards.find((row) => row.post_id === shownId)
  if (card && shownId && !shown) {
    await posts.setStatus(transaction, { ...thread.place, postId: shownId, body: card })
  }
  for (const row of cards) {
    const body: unknown = JSON.parse(String(row.body))
    if (row.post_id !== shownId && adapter.isOpenCard(body)) {
      await posts.setStatus(transaction, {
        ...thread.place,
        postId: String(row.post_id),
        body: adapter.settledCard(body, { kind: 'closed' })
      })
    }
  }
  return prompt !== null && (!shown || adapter.isOpenCard(JSON.parse(String(shown.body))))
}

// A press of an answer button on a prompt card. What it answers is found from the message it is
// on (its messageRef, in channelId: the container, or the thread where threads are channels); the
// button only says which option.
export type CardPress = {
  workspaceId: string
  channelId: string
  messageRef: string
  userId: string
  optionId: string
  paused: boolean
}

// What to tell the person who pressed, privately; the source's ingress delivers it.
export type PressReply = { target: NoticeTarget; postId: string; notice: Notice }

// Decisions §1: only the conversation's owner answers; anyone else is told so privately.
export async function answerPromptCard(
  deps: { database: CloudDatabase; queue: QueueInTransaction; threadPosts: ThreadPosts },
  press: CardPress
): Promise<PressReply | null> {
  const { queue, threadPosts } = deps
  const { adapter, posts } = threadPosts
  const source: ConnectorSource = adapter.source
  return await deps.database.transaction(async (transaction): Promise<PressReply | null> => {
    const [message] = await transaction.query(
      `SELECT post_id, container_id, thread_id, body FROM connector_posts
       WHERE source = ? AND workspace_id = ? AND message_ref = ? AND kind = 'status'
         AND (container_id = ? OR thread_id = ?)`,
      [source, press.workspaceId, press.messageRef, press.channelId, press.channelId]
    )
    if (!message) {
      return null
    }
    const postId = String(message.post_id)
    const place = {
      workspaceId: press.workspaceId,
      containerId: String(message.container_id),
      threadId: String(message.thread_id)
    }
    const threads = await transaction.query(
      `SELECT external_id, host_id FROM connector_threads
       WHERE source = ? AND workspace_id = ? AND container_id = ? AND thread_id = ?`,
      [source, place.workspaceId, place.containerId, place.threadId]
    )
    const thread = threads.find((row) =>
      postId.startsWith(promptCardId(String(row.external_id), ''))
    )
    if (!thread) {
      return null
    }
    const externalId = String(thread.external_id)
    const target: NoticeTarget = { place, userId: press.userId, direct: false }
    if (press.paused) {
      return {
        target,
        postId: `paused:${place.workspaceId}:${place.containerId}:${place.threadId}:${press.userId}`,
        notice: { kind: 'paused' }
      }
    }
    // Cards close only under the host lock (events, presses), so this read holds until commit.
    await lockConnectorHost(transaction, String(thread.host_id))
    const [card] = await transaction.query(
      'SELECT body FROM connector_posts WHERE source = ? AND post_id = ?',
      [source, postId]
    )
    const movedOn: PressReply = {
      target,
      postId: `moved-on:${postId}:${press.userId}`,
      notice: { kind: 'already_answered' }
    }
    if (!adapter.isOpenCard(JSON.parse(String(card?.body ?? '{}')))) {
      return movedOn
    }
    const action: OwnerAction = {
      kind: 'answer',
      promptId: postId.slice(promptCardId(externalId, '').length),
      optionId: press.optionId
    }
    const conversation = { source, externalId }
    const outcome = await applyOwnerAction(transaction, queue, conversation, press.userId, action)
    switch (outcome?.kind) {
      case 'not_owner':
        return {
          target,
          postId: `only-owner:${postId}:${press.userId}`,
          notice: { kind: 'only_owner', ownerUserId: outcome.ownerUserId }
        }
      case 'moved_on':
        return movedOn
      case 'answered':
        await threadPosts.lockStatus(transaction, externalId)
        await posts.setStatus(transaction, {
          ...place,
          postId,
          body: adapter.settledCard(JSON.parse(String(message.body)), {
            kind: 'answered',
            ownerUserId: outcome.ownerUserId,
            label: outcome.label
          })
        })
        await threadPosts.refresh(transaction, String(thread.host_id), externalId)
        return null
      default:
        return null
    }
  })
}
