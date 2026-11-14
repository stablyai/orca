import { describe, expect, it, vi } from 'vitest'
import { dialRelayThroughDirectorFallback } from './mobile-relay-director-fallback'
import { RelayHostOfflineStreak } from './relay-host-offline-streak'
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

function dialer(
  results: { ok: boolean; error?: Error }[],
  resolved: typeof relay = { ...relay, cellUrl: 'https://relay-hk.onorca.dev', assignmentEpoch: 8 }
) {
  const streak = new RelayHostOfflineStreak(() => null)
  const resolveRelay = vi.fn(async () => resolved)
  const persistResolvedRelay = vi.fn(async () => {})
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
      persistResolvedRelay
    })
  return { attempt, dial, resolveRelay, persistResolvedRelay }
}

describe('dialRelayThroughDirectorFallback on host-offline', () => {
  it('resolves on the second consecutive 4404 and redials the moved cell once', async () => {
    const { attempt, dial, resolveRelay } = dialer([hostOffline, hostOffline, { ok: true }])
    await expect(attempt()).resolves.toEqual(hostOffline)
    expect(resolveRelay).not.toHaveBeenCalled()

    await expect(attempt()).resolves.toEqual({ ok: true })
    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(dial).toHaveBeenCalledTimes(3)
  })

  it('does not redial when the director still names the same cell', async () => {
    const { attempt, dial, resolveRelay, persistResolvedRelay } = dialer(
      [hostOffline, hostOffline],
      relay
    )
    await attempt()
    await expect(attempt()).resolves.toEqual(hostOffline)
    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(persistResolvedRelay).not.toHaveBeenCalled()
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('never resolves on attach timeouts, which prove the desktop is seated on this cell', async () => {
    const { attempt, resolveRelay } = dialer([attachTimeout, attachTimeout, attachTimeout])
    for (let i = 0; i < 3; i++) {
      await attempt()
    }
    expect(resolveRelay).not.toHaveBeenCalled()
  })
})
