import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Bot } from '../../shared/bot-types'
import type { BotRunChatCloseAfter } from '../../shared/bots/bot-run-chat-close'
import { BotRunChatCloser, type BotRunChatState } from './bot-run-chat-close'

const HOUR = 60 * 60 * 1000
const Tracked = z.object({ chats: z.array(z.object({ sessionId: z.string() })) })

function closerWith(input: {
  bots: Pick<Bot, 'id' | 'runChatsCloseAfter'>[]
  hostDefault: BotRunChatCloseAfter
  chats: Record<string, BotRunChatState>
  busy?: string[]
}) {
  let now = 0
  const files = new Map<string, string>()
  const closed: string[] = []
  const closer = new BotRunChatCloser({
    path: () => 'list.json',
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => void files.set(path, text),
    now: () => now,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the closer reads only id and runChatsCloseAfter.
    bots: () => input.bots as Bot[],
    hostDefault: () => input.hostDefault,
    chatsOf: async () => (sessionId) => input.chats[sessionId] ?? null,
    busy: async (_bot, sessionId) => input.busy?.includes(sessionId) ?? false,
    close: async (sessionId) => {
      closed.push(sessionId)
      return true
    }
  })
  return {
    closer,
    closed,
    at: (ms: number) => {
      now = ms
    },
    tracked: () =>
      Tracked.parse(JSON.parse(files.get('list.json') ?? '{"chats":[]}')).chats.map(
        (entry) => entry.sessionId
      )
  }
}

describe('BotRunChatCloser', () => {
  it('closes only idle, unkept chats past their own bot window or the host default', async () => {
    const run = closerWith({
      bots: [
        { id: 'follows' },
        { id: 'week', runChatsCloseAfter: '7d' },
        { id: 'never', runChatsCloseAfter: 'never' }
      ],
      hostDefault: '24h',
      chats: {
        due: { lastActivityAt: 0, kept: false },
        replied: { lastActivityAt: 20 * HOUR, kept: false },
        linked: { lastActivityAt: 0, kept: true },
        working: { lastActivityAt: 0, kept: false },
        weekly: { lastActivityAt: 0, kept: false },
        forever: { lastActivityAt: 0, kept: false }
      },
      busy: ['working']
    })
    for (const [bot, sessionId] of [
      ['follows', 'due'],
      ['follows', 'replied'],
      ['follows', 'linked'],
      ['follows', 'working'],
      ['week', 'weekly'],
      ['never', 'forever'],
      ['follows', 'gone']
    ]) {
      run.closer.arm({ id: bot }, sessionId)
    }
    run.at(25 * HOUR)
    await run.closer.sweep()
    run.closer.clear()

    expect(run.closed).toEqual(['due'])
    expect(run.tracked().sort()).toEqual(['forever', 'replied', 'weekly', 'working'])
  })
})
