import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionContextUsage } from '../../shared/agent-session/conversation-context/agent-session-context-usage'
import { createBotMemorySaveLedger, type BotMemorySaveLedgerFile } from './bot-memory-save-ledger'
import { createBotMemorySaveWatch, type BotMemorySaveWatchDeps } from './bot-memory-save-watch'

const report = (usedTokens: number, windowTokens = 200_000): AgentSessionContextUsage => ({
  used: {
    kind: 'report',
    model: 'm',
    usedTokens,
    windowTokens,
    percentage: Math.round((usedTokens / windowTokens) * 100),
    categories: [],
    capturedAt: 1
  }
})

function memoryFile(
  initial: string | null = null
): BotMemorySaveLedgerFile & { text: string | null } {
  const file = {
    text: initial,
    load: async () => file.text,
    save: async (text: string) => {
      file.text = text
    }
  }
  return file
}

function setup(overrides: Partial<BotMemorySaveWatchDeps> = {}, file = memoryFile()) {
  let usage = report(0)
  let idle = true
  const events: string[] = []
  const send = vi.fn(async (_botId: string, _sessionId: string, memorySave: unknown) => {
    events.push(`send:${file.text}`)
    void memorySave
  })
  const deps: BotMemorySaveWatchDeps = {
    ledger: createBotMemorySaveLedger(file),
    ownChatBot: (sessionId) => (sessionId === 'home' ? 'bot-1' : null),
    contextUsage: async () => usage,
    idle: async () => idle,
    send,
    ...overrides
  }
  const watch = createBotMemorySaveWatch(deps)
  return {
    watch,
    send,
    events,
    file,
    setUsage: (next: AgentSessionContextUsage) => (usage = next),
    setIdle: (next: boolean) => (idle = next)
  }
}

describe('bot memory save watch', () => {
  it('starts one save at the threshold, with the ring reading, and not again in that window', async () => {
    const t = setup()
    t.setUsage(report(149_000))
    await t.watch.turnEnded('home')
    expect(t.send).not.toHaveBeenCalled()

    t.setUsage(report(150_000))
    await t.watch.turnEnded('home')
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.send).toHaveBeenCalledWith('bot-1', 'home', { percent: 75, estimated: false })

    // The save's own turn end and later turns in the same window start nothing.
    for (const used of [155_000, 180_000, 140_000]) {
      t.setUsage(report(used))
      await t.watch.turnEnded('home')
    }
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('re-arms only after a measured drop to rearmAt, then saves once more', async () => {
    const t = setup()
    t.setUsage(report(160_000))
    await t.watch.turnEnded('home')
    t.setUsage(report(30_000))
    await t.watch.turnEnded('home')
    expect(t.send).toHaveBeenCalledTimes(1)
    t.setUsage(report(151_000))
    await t.watch.turnEnded('home')
    expect(t.send).toHaveBeenCalledTimes(2)
  })

  it('records the attempt on disk before it sends, so a restart never saves twice', async () => {
    const file = memoryFile()
    const first = setup({}, file)
    first.setUsage(report(170_000))
    await first.watch.turnEnded('home')
    expect(first.events).toEqual([`send:${JSON.stringify({ home: JSON.parse(file.text!).home })}`])
    expect(JSON.parse(file.text!).home.armed).toBe(false)

    // A new process with the same file: still the same window.
    const restarted = setup({}, file)
    restarted.setUsage(report(175_000))
    await restarted.watch.turnEnded('home')
    expect(restarted.send).not.toHaveBeenCalled()
  })

  it('keeps the window used when the send fails', async () => {
    const t = setup({
      send: vi.fn(async () => {
        throw new Error('refused')
      })
    })
    t.setUsage(report(170_000))
    await t.watch.turnEnded('home')
    expect(JSON.parse(t.file.text!).home.armed).toBe(false)
  })

  it('waits while the chat is busy and saves at the next idle turn end', async () => {
    const t = setup({ later: () => {} })
    t.setUsage(report(170_000))
    t.setIdle(false)
    await t.watch.turnEnded('home')
    expect(t.send).not.toHaveBeenCalled()
    // Busy never uses the window.
    expect(t.file.text).toBeNull()
    t.setIdle(true)
    await t.watch.turnEnded('home')
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('looks again a bounded number of times when a due save finds the chat busy', async () => {
    const checks: (() => void)[] = []
    const t = setup({ later: (check) => checks.push(check) })
    t.setUsage(report(170_000))
    t.setIdle(false)
    await t.watch.turnEnded('home')
    expect(checks).toHaveLength(1)
    checks.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(checks).toHaveLength(1)
    // Settled now: the second look starts the save, once.
    t.setIdle(true)
    checks.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(checks).toHaveLength(0)
  })

  it('stops looking after the bounded rechecks', async () => {
    const checks: (() => void)[] = []
    const t = setup({ later: (check) => checks.push(check) })
    t.setUsage(report(170_000))
    t.setIdle(false)
    await t.watch.turnEnded('home')
    for (let i = 0; i < 5 && checks.length > 0; i++) {
      checks.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(checks).toHaveLength(0)
    expect(t.send).not.toHaveBeenCalled()
  })

  it('never saves for a chat that is not a bot’s own, or with nothing measured', async () => {
    const t = setup()
    t.setUsage(report(190_000))
    await t.watch.turnEnded('worker')
    t.setUsage({})
    await t.watch.turnEnded('home')
    expect(t.send).not.toHaveBeenCalled()
  })

  it('starts nothing while the ledger is unreadable', async () => {
    const t = setup({}, memoryFile('not json'))
    t.setUsage(report(190_000))
    await t.watch.turnEnded('home')
    expect(t.send).not.toHaveBeenCalled()
  })

  it('decides one turn end at a time per chat', async () => {
    const t = setup()
    t.setUsage(report(190_000))
    await Promise.all([t.watch.turnEnded('home'), t.watch.turnEnded('home')])
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('stores no number when the ring would show none', async () => {
    const t = setup()
    t.setUsage({
      used: {
        kind: 'estimate',
        usage: {
          inputTokens: 160_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0
        },
        capturedAt: 1
      }
    })
    await t.watch.turnEnded('home')
    expect(t.send).toHaveBeenCalledWith('bot-1', 'home', {})
  })
})
