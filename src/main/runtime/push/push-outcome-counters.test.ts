import { expect, it, vi } from 'vitest'
import { PushOutcomeCounters } from './push-outcome-counters'
it('limits failure logs while retaining category counts', () => {
  let now = 0
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const counters = new PushOutcomeCounters(() => now)
    counters.record('rejected')
    counters.record('error')
    counters.record('error')
    expect(log).toHaveBeenCalledTimes(1)
    now += 60_000
    counters.record('rate_limited')
    expect(JSON.parse(String(log.mock.calls[1]![0]))).toEqual({
      event: 'orca_desktop_push_failures',
      error: 2,
      rate_limited: 1
    })
    counters.record('unreachable')
    counters.flush()
    expect(log).toHaveBeenCalledTimes(3)
  } finally {
    log.mockRestore()
  }
})
