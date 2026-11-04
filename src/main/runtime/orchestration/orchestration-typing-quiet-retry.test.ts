import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_TYPING_QUIET_MS } from './orchestration-typing-quiet'
import { OrchestrationTypingQuietRetry } from './orchestration-typing-quiet-retry'

const typing = {
  lastUserInputAt: 9_200,
  now: 10_000,
  windowFocused: true
}

describe('OrchestrationTypingQuietRetry reserved types (#11279)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges reserved types when two callers defer the same mailbox', () => {
    vi.useFakeTimers()
    const redrive = vi.fn()
    const retry = new OrchestrationTypingQuietRetry(redrive)

    expect(retry.defer(typing, 'run:1', new Set(['worker_done']))).toBe(true)
    expect(retry.defer({ ...typing, now: 10_100 }, 'run:1', new Set(['escalation']))).toBe(true)

    vi.advanceTimersByTime(ORCHESTRATION_TYPING_QUIET_MS)
    expect(redrive).toHaveBeenCalledTimes(1)
    const reserved = redrive.mock.calls[0]?.[1] as Set<string> | undefined
    expect(reserved).toEqual(new Set(['worker_done', 'escalation']))
  })

  it('does not keep only the latest reserved set', () => {
    vi.useFakeTimers()
    const redrive = vi.fn()
    const retry = new OrchestrationTypingQuietRetry(redrive)

    retry.defer(typing, 'run:1', new Set(['question']))
    retry.defer({ ...typing, now: 10_050 }, 'run:1', new Set(['worker_done']))

    vi.advanceTimersByTime(ORCHESTRATION_TYPING_QUIET_MS)
    const reserved = [...((redrive.mock.calls[0]?.[1] as Set<string> | undefined) ?? [])].sort()
    expect(reserved).toEqual(['question', 'worker_done'])
  })
})
