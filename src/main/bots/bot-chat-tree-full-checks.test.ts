import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotChatTreeFullChecks } from './bot-chat-tree-full-checks'

const MINUTE = 60_000

function checks(options: { idle?: () => boolean; ms?: number } = {}) {
  const verified: string[] = []
  const full = new BotChatTreeFullChecks({
    idle: options.idle ?? (() => true),
    now: () => Date.now(),
    verify: (botId) => {
      verified.push(botId)
      return options.ms ?? 10
    }
  })
  return { full, verified }
}

describe('BotChatTreeFullChecks', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }))
  afterEach(() => vi.useRealTimers())

  it('checks each kept bot once every 15 min while idle, one bot per run', () => {
    const { full, verified } = checks()
    full.track('bot-a')
    full.track('bot-b')
    vi.advanceTimersByTime(15 * MINUTE - 1)
    expect(verified).toEqual([])
    vi.advanceTimersByTime(1)
    expect(verified).toEqual(['bot-a'])
    // The next bot runs on its own timer, never in the same task.
    vi.advanceTimersByTime(1)
    expect(verified).toEqual(['bot-a', 'bot-b'])
    vi.advanceTimersByTime(15 * MINUTE)
    expect(verified).toEqual(['bot-a', 'bot-b', 'bot-a', 'bot-b'])
    full.dispose()
  })

  it('waits for a quiet minute after a change, and never checks a busy host', () => {
    let idle = false
    const { full, verified } = checks({ idle: () => idle })
    full.track('bot-a')
    vi.advanceTimersByTime(15 * MINUTE)
    expect(verified).toEqual([])
    idle = true
    full.noteChange()
    vi.advanceTimersByTime(MINUTE - 1)
    expect(verified).toEqual([])
    vi.advanceTimersByTime(1)
    expect(verified).toEqual(['bot-a'])
    full.dispose()
  })

  it('pushes a slow check further out, and makes every bot due after a store or database swap', () => {
    const { full, verified } = checks({ ms: 500 })
    full.track('bot-a')
    vi.advanceTimersByTime(15 * MINUTE)
    expect(verified).toEqual(['bot-a'])
    // Over budget: the next check is 30 min out, not 15.
    vi.advanceTimersByTime(15 * MINUTE)
    expect(verified).toEqual(['bot-a'])
    vi.advanceTimersByTime(15 * MINUTE)
    expect(verified).toEqual(['bot-a', 'bot-a'])
    full.dueAll()
    vi.advanceTimersByTime(1)
    expect(verified).toEqual(['bot-a', 'bot-a', 'bot-a'])
    full.dispose()
  })
})
