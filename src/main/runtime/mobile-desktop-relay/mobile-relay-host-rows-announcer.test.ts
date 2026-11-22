import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type { DescribedRelayHost } from './mobile-relay-host-descriptions'
import { RelayHostRowsAnnouncer } from './mobile-relay-host-rows-announcer'

type WatchCallbacks = Parameters<MobileDesktopRelayHosts['watchChanges']>[2]

const host: DescribedRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Build box',
  health: 'available',
  relay: 'ready',
  environmentId: 'env-1',
  identity: { pairingRevision: 1, runtimeId: 'rt-1' }
}

function fakeHosts() {
  const watches: { callbacks: WatchCallbacks; close: ReturnType<typeof vi.fn> }[] = []
  const only = () => {
    const [watch] = watches
    if (!watch) {
      throw new Error('no watch opened')
    }
    return watch
  }
  return {
    watches,
    only,
    hosts: {
      watchChanges: (_host: unknown, _expected: unknown, callbacks: WatchCallbacks) => {
        const close = vi.fn()
        watches.push({ callbacks, close })
        return { close, current: () => true }
      }
    }
  }
}

function reader(connectionId: string) {
  const releases: (() => void)[] = []
  return {
    releases,
    reader: { connectionId, onClose: (release: () => void) => releases.push(release) }
  }
}

describe('RelayHostRowsAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("forwards a burst of a server's row notices to phones as one coalesced change", async () => {
    const { hosts, watches, only } = fakeHosts()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(hosts, changed)
    announcer.hold(host, reader('phone-1').reader)
    await vi.runAllTimersAsync()
    expect(watches).toHaveLength(1)

    only().callbacks.onRowsChanged?.()
    only().callbacks.onRowsChanged?.()
    only().callbacks.onChange({ catalog: false })
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith('runtime:env-1')
  })

  it('watches a server once, until the last phone connection that read it closes', async () => {
    const { hosts, watches, only } = fakeHosts()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(hosts, changed)
    const first = reader('phone-1')
    const second = reader('phone-2')
    announcer.hold(host, first.reader)
    announcer.hold(host, first.reader)
    announcer.hold(host, second.reader)
    await vi.runAllTimersAsync()
    expect(watches).toHaveLength(1)
    // A connection that reads again holds no second release.
    expect(first.releases).toHaveLength(1)

    first.releases[0]?.()
    expect(only().close).not.toHaveBeenCalled()
    second.releases[0]?.()
    expect(only().close).toHaveBeenCalledTimes(1)

    only().callbacks.onRowsChanged?.()
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).not.toHaveBeenCalled()
  })
})
