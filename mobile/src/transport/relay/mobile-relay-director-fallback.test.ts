import { describe, expect, it, vi } from 'vitest'
import {
  dialRelayThroughDirectorFallback,
  RelayDialAbortedError,
  RelayHostOfflineStreak
} from './mobile-relay-director-fallback'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-edge.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

const hostOffline = { ok: false as const, error: new RelayOuterError(4404) }
const attachTimeout = {
  ok: false as const,
  error: new RelayOuterError(4404, false, 'attach-timeout')
}

function dialer(results: { ok: boolean; error?: Error }[]) {
  const streak = new RelayHostOfflineStreak()
  const resolveRelay = vi.fn(async () => ({ ...relay, cellUrl: 'https://relay-hk.onorca.dev' }))
  const queue = [...results]
  const dial = vi.fn(async () => {
    const next = queue.shift() ?? { ok: true }
    return next.ok ? { ok: true as const } : { ok: false as const, error: next.error! }
  })
  const attempt = () =>
    dialRelayThroughDirectorFallback({
      resumeToken: 'A'.repeat(43),
      hostOfflineStreak: streak,
      relay: () => relay,
      dial,
      resolveRelay,
      persistResolvedRelay: async () => {}
    })
  return { attempt, dial, resolveRelay }
}

describe('dialRelayThroughDirectorFallback on host-offline', () => {
  it('resolves on the second consecutive 4404 and redials the resolved cell once', async () => {
    const { attempt, dial, resolveRelay } = dialer([hostOffline, hostOffline, { ok: true }])
    await expect(attempt()).resolves.toEqual(hostOffline)
    expect(resolveRelay).not.toHaveBeenCalled()

    await expect(attempt()).resolves.toEqual({ ok: true })
    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(dial).toHaveBeenCalledTimes(3)
  })

  it('paces resolves to every other 4404 while the edge keeps answering it', async () => {
    const { attempt, resolveRelay } = dialer(Array.from({ length: 8 }, () => hostOffline))
    // Each resolve redials once; 4 recovery cycles = 6 dials incl. the 2 post-resolve redials.
    for (let i = 0; i < 4; i++) {
      await attempt()
    }
    expect(resolveRelay).toHaveBeenCalledTimes(2)
  })

  it('never resolves on attach timeouts, which prove the desktop is seated on this cell', async () => {
    const { attempt, resolveRelay } = dialer([
      attachTimeout,
      attachTimeout,
      hostOffline,
      attachTimeout,
      hostOffline
    ])
    for (let i = 0; i < 5; i++) {
      await attempt()
    }
    expect(resolveRelay).not.toHaveBeenCalled()
  })

  it('restarts the streak after a success or another failure, but not after a local abort', async () => {
    const aborted = { ok: false as const, error: new RelayDialAbortedError() }
    const { attempt, resolveRelay } = dialer([
      hostOffline,
      { ok: true },
      hostOffline,
      { ok: false, error: new RelayOuterError(4408) },
      hostOffline,
      aborted,
      hostOffline
    ])
    for (let i = 0; i < 6; i++) {
      await attempt()
    }
    expect(resolveRelay).not.toHaveBeenCalled()
    await attempt()
    expect(resolveRelay).toHaveBeenCalledOnce()
  })
})
