import { describe, expect, it } from 'vitest'
import { cancelHostListHealthChecks, joinHostListHealthCheck } from './mcp-host-list-health-checks'

/** A check that runs until it's stopped, counting the runs it started. */
function stoppableCheck() {
  const runs: AbortSignal[] = []
  const run = (signal: AbortSignal) => {
    runs.push(signal)
    return new Promise<Record<string, never>>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    )
  }
  return { runs, run }
}

describe('the host list’s shared problems check', () => {
  it('stops only when the last client waiting on it lets go', async () => {
    const check = stoppableCheck()
    const desktop = joinHostListHealthCheck('claude\0all', 'desktop', undefined, check.run)
    const phoneRequest = new AbortController()
    const phone = joinHostListHealthCheck('claude\0all', 'phone', phoneRequest.signal, check.run)
    expect(check.runs).toHaveLength(1)

    cancelHostListHealthChecks('desktop')
    expect(check.runs[0]?.aborted).toBe(false)

    // The phone's connection drops: nobody waits any more, so the check stops.
    phoneRequest.abort()
    expect(check.runs[0]?.aborted).toBe(true)
    await expect(desktop).rejects.toThrow('stopped')
    await expect(phone).rejects.toThrow('stopped')

    // A request after that starts a check of its own.
    const again = joinHostListHealthCheck('claude\0all', 'desktop', undefined, check.run)
    expect(check.runs).toHaveLength(2)
    cancelHostListHealthChecks('desktop')
    await expect(again).rejects.toThrow('stopped')
  })
})
