import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropSharedHostListLoad,
  shareHostListLoad,
  type HostListSnapshot
} from './host-list-load-sharing'
import type { HostProfile } from './types'

function snapshot(id: string): HostListSnapshot {
  const stored = {
    id,
    name: id,
    endpoint: 'ws://127.0.0.1:1',
    publicKeyB64: `key-${id}`,
    lastConnected: 0
  }
  const profile: HostProfile = { ...stored, deviceToken: 'token' }
  return { catalog: [{ ...stored, credentialStatus: 'ready', profile }], profiles: [profile] }
}

function deferred() {
  let resolve: (hosts: HostListSnapshot) => void = () => {}
  const promise = new Promise<HostListSnapshot>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('shareHostListLoad', () => {
  beforeEach(() => {
    dropSharedHostListLoad()
  })

  it('runs one pass for callers that arrive while it is still open', async () => {
    const pass = deferred()
    const load = vi.fn(() => pass.promise)

    const first = shareHostListLoad(load)
    const second = shareHostListLoad(load)
    const value = snapshot('host-ready')
    pass.resolve(value)

    expect(load).toHaveBeenCalledTimes(1)
    expect(await first).toBe(await second)
    expect(await first).toEqual(value)

    const next = shareHostListLoad(load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(await next).toEqual(value)
  })

  it('starts a fresh pass for callers that arrive after a write dropped it', async () => {
    const stale = deferred()
    const fresh = deferred()
    const load = vi
      .fn<() => Promise<HostListSnapshot>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const before = shareHostListLoad(load)
    dropSharedHostListLoad()
    const after = shareHostListLoad(load)

    const staleValue = snapshot('host-stale')
    const freshValue = snapshot('host-fresh')
    stale.resolve(staleValue)
    fresh.resolve(freshValue)
    expect(load).toHaveBeenCalledTimes(2)
    expect(await after).not.toBe(await before)
    expect(await before).toEqual(staleValue)
    expect(await after).toEqual(freshValue)
  })

  it('keeps the replacement pass on offer when the dropped one settles late', async () => {
    const stale = deferred()
    const fresh = deferred()
    const load = vi
      .fn<() => Promise<HostListSnapshot>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const before = shareHostListLoad(load)
    dropSharedHostListLoad()
    const replacement = shareHostListLoad(load)
    // The dropped pass settles after its replacement was registered.
    const staleValue = snapshot('host-stale')
    stale.resolve(staleValue)
    expect(await before).toEqual(staleValue)

    expect(shareHostListLoad(load)).toBe(replacement)
    expect(load).toHaveBeenCalledTimes(2)
    const freshValue = snapshot('host-fresh')
    fresh.resolve(freshValue)
    expect(await replacement).toEqual(freshValue)
  })
})
