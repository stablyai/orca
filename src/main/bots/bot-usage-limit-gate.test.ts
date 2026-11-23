import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotUsageLimitGate, type BotUsageLimitKey } from './bot-usage-limit-gate'

const CLAUDE_SONNET: BotUsageLimitKey = {
  agent: 'claude',
  accountHomeKey: 'acct-a',
  model: 'claude-sonnet-4-5'
}

const CLAUDE_OTHER_ACCT: BotUsageLimitKey = {
  agent: 'claude',
  accountHomeKey: 'acct-b',
  model: 'claude-sonnet-4-5'
}

const CODEX_GPT5: BotUsageLimitKey = {
  agent: 'codex',
  accountHomeKey: 'acct-a',
  model: 'gpt-5-codex'
}

describe('BotUsageLimitGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isolates limits per (agent, accountHomeKey, model) and releases after reset + grace', async () => {
    const released: BotUsageLimitKey[] = []
    const gate = new BotUsageLimitGate({
      onLimitReleased: (key) => released.push(key)
    })

    const resetsAt = Date.now() + 60_000
    gate.recordLimit({ ...CLAUDE_SONNET, resetsAt })

    expect(gate.isLimited(CLAUDE_SONNET)).toBe(true)
    expect(gate.isLimited(CLAUDE_OTHER_ACCT)).toBe(false)
    expect(gate.isLimited(CODEX_GPT5)).toBe(false)
    expect(gate.limitResetAt(CLAUDE_SONNET)).toBe(resetsAt)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(gate.isLimited(CLAUDE_SONNET)).toBe(true)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(gate.isLimited(CLAUDE_SONNET)).toBe(false)
    expect(released).toEqual([CLAUDE_SONNET])
    gate.dispose()
  })

  it('holds return when readSpentUntil still reports a future spent window and releases once cleared', async () => {
    const released: BotUsageLimitKey[] = []
    let spentUntil: number | undefined = Date.now() + 120_000
    const gate = new BotUsageLimitGate({
      readSpentUntil: async () => spentUntil,
      onLimitReleased: (key) => released.push(key)
    })

    gate.recordLimit({ ...CLAUDE_SONNET, resetsAt: Date.now() + 30_000 })
    await vi.advanceTimersByTimeAsync(45_000)

    // Still spent according to authoritative rate-limit snapshot: must stay limited and re-arm.
    expect(gate.isLimited(CLAUDE_SONNET)).toBe(true)
    expect(released).toEqual([])
    expect(gate.limitResetAt(CLAUDE_SONNET)).toBe(spentUntil)

    spentUntil = undefined
    await vi.advanceTimersByTimeAsync(105_000)
    expect(gate.isLimited(CLAUDE_SONNET)).toBe(false)
    expect(released).toEqual([CLAUDE_SONNET])
    gate.dispose()
  })

  it('computes earliestResetAt, clears an account immediately on switch, and cancels timers on dispose', async () => {
    const released: BotUsageLimitKey[] = []
    const gate = new BotUsageLimitGate({
      onLimitReleased: (key) => released.push(key)
    })

    const t1 = Date.now() + 300_000
    const t2 = Date.now() + 120_000
    gate.recordLimit({ ...CLAUDE_SONNET, resetsAt: t1 })
    gate.recordLimit({ ...CODEX_GPT5, resetsAt: t2 })
    expect(gate.earliestResetAt([CLAUDE_SONNET, CODEX_GPT5])).toBe(t2)

    gate.clearAccount('claude', 'acct-a')
    expect(gate.isLimited(CLAUDE_SONNET)).toBe(false)
    expect(gate.isLimited(CODEX_GPT5)).toBe(true)
    expect(released).toEqual([CLAUDE_SONNET])

    gate.dispose()
    await vi.advanceTimersByTimeAsync(600_000)
    // Disposed gate must not emit further release callbacks.
    expect(released).toEqual([CLAUDE_SONNET])
  })
})
