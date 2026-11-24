import { describe, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { BotRunChatCloseAfter } from '../../shared/bots/bot-run-chat-close'
import { BotRunChatCloser, type BotRunChatState } from './bot-run-chat-close'

const HOUR = 60 * 60 * 1000

function botOf(id: string, runChatsCloseAfter?: BotRunChatCloseAfter): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the closer reads only id and runChatsCloseAfter.
  return { id, ...(runChatsCloseAfter ? { runChatsCloseAfter } : {}) } as Bot
}

function closerWith(input: {
  bots: Bot[]
  chats: Record<string, BotRunChatState>
  busy?: string[]
}) {
  let now = 0
  let file = ''
  let writes = 0
  const closed: string[] = []
  const closer = new BotRunChatCloser({
    path: () => 'list.jsonl',
    read: async () => file,
    append: async (_path, text) => {
      file += text
      writes += 1
    },
    write: async (_path, text) => {
      file = text
      writes += 1
    },
    now: () => now,
    bots: () => input.bots,
    hostDefault: () => '24h',
    ready: async () => {},
    chat: (_bot, sessionId) => input.chats[sessionId] ?? null,
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
    writes: () => writes,
    tracked: () =>
      file
        .split('\n')
        .filter(Boolean)
        .map((line) => String(JSON.parse(line).sessionId))
  }
}

describe('BotRunChatCloser', () => {
  it('closes only idle, unkept chats past their window, and every kept due chat moves on', async () => {
    const bots = [botOf('follows'), botOf('week', '7d'), botOf('never', 'never')]
    const run = closerWith({
      bots,
      chats: {
        due: { lastActivityAt: 0, kept: false },
        renamed: { lastActivityAt: 12 * HOUR, kept: false },
        linked: { lastActivityAt: 0, kept: true },
        working: { lastActivityAt: 0, kept: false },
        weekly: { lastActivityAt: 0, kept: false },
        forever: { lastActivityAt: 0, kept: false },
        otherProfile: { lastActivityAt: 0, kept: false }
      },
      busy: ['working']
    })
    for (const [bot, sessionId] of [
      [bots[0], 'due'],
      [bots[0], 'renamed'],
      [bots[0], 'linked'],
      [bots[0], 'working'],
      [bots[1], 'weekly'],
      [bots[2], 'forever'],
      [bots[0], 'gone'],
      [botOf('elsewhere'), 'otherProfile']
    ] as const) {
      run.closer.arm(bot, sessionId)
    }
    run.at(25 * HOUR)
    await run.closer.sweep()
    const writes = run.writes()
    // Nothing kept is due again, so the timer doesn't refire into another sweep.
    await run.closer.sweep()
    run.closer.clear()

    expect(run.closed).toEqual(['due'])
    expect(run.tracked().sort()).toEqual(['otherProfile', 'renamed', 'weekly', 'working'])
    expect(run.writes()).toBe(writes)
  })
})
