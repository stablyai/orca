import { describe, expect, it } from 'vitest'
import {
  WSL_ORCAD_RECONNECT_DELAYS_MS,
  WSL_ORCAD_STABLE_MS,
  WSL_ORCAD_VERIFY_RETRY_CAP_MS,
  WslOrcadReconnectBackoff,
  wslOrcadVerifyRetryDelayMs
} from './wsl-orcad-reconnect-backoff'

describe('WslOrcadReconnectBackoff', () => {
  it('walks the ladder within its jitter bounds, then gives up', () => {
    const backoff = new WslOrcadReconnectBackoff(() => 0.999)
    for (const [index, floor] of WSL_ORCAD_RECONNECT_DELAYS_MS.entries()) {
      const decision = backoff.next(0)
      expect(decision.kind).toBe('retry')
      if (decision.kind === 'retry') {
        expect(decision.attempt).toBe(index + 1)
        expect(decision.delayMs).toBeGreaterThanOrEqual(floor)
        expect(decision.delayMs).toBeLessThanOrEqual(floor * 1.2)
      }
    }
    expect(backoff.next(0)).toEqual({
      kind: 'give-up',
      attempts: WSL_ORCAD_RECONNECT_DELAYS_MS.length
    })
  })

  it('restarts the ladder only after a stable stretch of monotonic time', () => {
    const backoff = new WslOrcadReconnectBackoff(() => 0)
    backoff.next(0)
    backoff.next(0)
    backoff.noteReady(1_000)
    expect(backoff.next(1_000 + WSL_ORCAD_STABLE_MS - 1)).toMatchObject({ attempt: 3 })
    backoff.noteReady(5_000)
    expect(backoff.next(5_000 + WSL_ORCAD_STABLE_MS)).toMatchObject({ attempt: 1 })
  })

  it('is driven only by the monotonic time it is given, so a wall-clock jump changes nothing', () => {
    const backoff = new WslOrcadReconnectBackoff(() => 0)
    backoff.noteReady(10)
    const realNow = Date.now
    Date.now = () => realNow() + 365 * 24 * 3_600_000
    try {
      backoff.next(20)
      backoff.noteReady(30)
      expect(backoff.next(40)).toMatchObject({ attempt: 2 })
    } finally {
      Date.now = realNow
    }
  })
})

describe('wslOrcadVerifyRetryDelayMs', () => {
  it('doubles from a second and caps without ever giving up', () => {
    expect(wslOrcadVerifyRetryDelayMs(0)).toBe(1_000)
    expect(wslOrcadVerifyRetryDelayMs(1)).toBe(2_000)
    expect(wslOrcadVerifyRetryDelayMs(50)).toBe(WSL_ORCAD_VERIFY_RETRY_CAP_MS)
  })
})
