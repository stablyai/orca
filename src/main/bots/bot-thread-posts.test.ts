import { expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { BotThreadPosts } from './bot-thread-posts'

it('replays the original thread post after concurrent retries and after the thread is closed', async () => {
  const db = new Database(':memory:')
  const transcript = new Map<string, { text: string; wake: number }>()
  let closed = false
  try {
    const deps = {
      database: () => db,
      account: () => 'owner',
      openThread: async (_botId: string, threadId: string) => (closed ? null : threadId),
      ensureInbox: async () => {},
      write: async (
        _botId: string,
        row: { operation_id: string; thread_id: string; text: string; wake: number }
      ) => {
        transcript.set(row.thread_id, { text: row.text, wake: row.wake })
        return row.operation_id
      }
    }
    const posts = new BotThreadPosts(deps)
    const correlationId = posts.bind('owner', 'bot', 'original-thread', 'request')
    expect(posts.bind('owner', 'bot', 'different-thread', 'request')).toBe(correlationId)
    const post = {
      botId: 'bot',
      deliveryId: 'publication',
      correlationId,
      text: 'Done',
      wake: false
    }
    const [first, duplicate] = await Promise.all([
      posts.postToThread('owner', post),
      posts.postToThread('owner', { ...post, text: 'Duplicate', wake: true })
    ])
    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({
      destination: 'thread',
      thread_id: 'original-thread',
      wake: false
    })
    closed = true
    const restarted = new BotThreadPosts(deps)
    expect(await restarted.postToThread('owner', post)).toEqual(first)
    expect(transcript.get('original-thread')).toEqual({ text: 'Done', wake: 0 })

    const fallback = await restarted.postToThread('owner', {
      ...post,
      deliveryId: 'later',
      wake: true
    })
    const unbound = await restarted.postToThread('owner', {
      ...post,
      correlationId: 'unknown',
      deliveryId: 'unbound'
    })
    expect(fallback).toMatchObject({ destination: 'inbox', wake: false })
    expect(unbound.thread_id).toBe(fallback.thread_id)
    expect(transcript.get(fallback.thread_id)).toEqual({ text: 'Done', wake: 0 })

    const otherBot = await restarted.postToThread('owner', { ...post, botId: 'another-bot' })
    expect(otherBot.destination).toBe('inbox')
    expect(otherBot.thread_id).not.toBe(fallback.thread_id)
  } finally {
    db.close()
  }
})
