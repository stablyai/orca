import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropSharedHostListLoad,
  peekSettledHostList,
  shareHostListLoad,
  type HostListSnapshot
} from './host-list-load-sharing'
import type { HostProfile } from './host-profile'

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

  it('never offers a pass a write has since dropped for synchronous seeding', async () => {
    const stale = deferred()
    const fresh = deferred()
    const load = vi
      .fn<() => Promise<HostListSnapshot>>()
      .mockReturnValueOnce(Promise.resolve(snapshot('host-removed')))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    await shareHostListLoad(load)
    const before = shareHostListLoad(load)
    dropSharedHostListLoad()
    expect(peekSettledHostList()).toBeNull()

    const after = shareHostListLoad(load)
    const freshValue = snapshot('host-fresh')
    fresh.resolve(freshValue)
    await after
    stale.resolve(snapshot('host-stale'))
    await before
    expect(peekSettledHostList()).toEqual(freshValue)
  })
})
