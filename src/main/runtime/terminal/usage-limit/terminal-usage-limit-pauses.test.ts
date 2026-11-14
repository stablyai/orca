import { describe, expect, it, vi } from 'vitest'
import { TerminalUsageLimitPauses } from './terminal-usage-limit-pauses'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'

const HOUR = 60 * 60_000
const RESET = 10 * HOUR

function spent(updatedAt: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: RESET, resetDescription: null },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function event(hookEventName: string, extra: Partial<AgentHookEventPayload> = {}) {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo::wt-1',
    connectionId: null,
    hookEventName,
    ...extra
  }
}

function rig(pins: Record<string, string> = { 'repo::wt-1': 'acct-a' }) {
  let now = RESET - HOUR
  const send = vi.fn(async () => true)
  const pauses = new TerminalUsageLimitPauses({
    pinnedAccount: (worktreeId) => pins[worktreeId],
    reading: () => spent(now),
    requestReading: () => {},
    send,
    now: () => now
  })
  return { pauses, send, at: (time: number) => (now = time) }
}

const limited = event('StopFailure', { claudeStopFailure: 'rate_limit', turnEndedAt: 1 })

describe('TerminalUsageLimitPauses', () => {
  it('continues a pinned terminal once, after its account resets', async () => {
    const { pauses, send, at } = rig()
    pauses.observe(limited)
    await pauses.tick()
    expect(send).not.toHaveBeenCalled()

    at(RESET + 2 * 60_000)
    await pauses.tick()
    pauses.observe(limited)
    await pauses.tick()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('leaves the terminal alone once the person prompts before the reset', async () => {
    const { pauses, send, at } = rig()
    pauses.observe(limited)
    pauses.observe(event('UserPromptSubmit'))
    at(RESET + 2 * 60_000)
    await pauses.tick()

    expect(send).not.toHaveBeenCalled()
  })

  it('never continues a terminal outside a pinned worktree', async () => {
    const { pauses, send, at } = rig({})
    pauses.observe(limited)
    at(RESET + 2 * 60_000)
    await pauses.tick()

    expect(send).not.toHaveBeenCalled()
  })
})
