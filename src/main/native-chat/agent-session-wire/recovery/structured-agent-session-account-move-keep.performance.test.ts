// Perf contract for #43145: a keep that keeps failing is retried later each time, not every five
// seconds, and nothing is retried once a keep settles or the host is disposed. Fails when the
// fixed five-second retry is restored.
import { expect, it, vi } from 'vitest'
import { AccountMoveKeepRetries } from './structured-agent-session-account-move-keep'

it('retries a keep that keeps failing 6 times in ten minutes, and stops once it settles', () => {
  vi.useFakeTimers()
  try {
    let wakes = 0
    const retries: AccountMoveKeepRetries = new AccountMoveKeepRetries(() => {
      wakes++
      retries.failed('chat')
    })
    retries.failed('chat')
    vi.advanceTimersByTime(10 * 60_000)
    // 5, 15, 35, 75, 155 and 315 seconds in; a fixed five-second retry would make 120.
    expect(wakes).toBe(6)

    retries.settled('chat')
    vi.advanceTimersByTime(60 * 60_000)
    expect(wakes).toBe(6)

    retries.failed('chat')
    retries.dispose()
    vi.advanceTimersByTime(60 * 60_000)
    expect(wakes).toBe(6)
  } finally {
    vi.useRealTimers()
  }
})
