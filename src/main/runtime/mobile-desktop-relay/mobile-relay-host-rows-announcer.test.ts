import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type { DescribedRelayHost } from './mobile-relay-host-descriptions'
import {
  RelayHostRowsAnnouncer,
  UNACKNOWLEDGED_NOTICE_RELEASE_MS
} from './mobile-relay-host-rows-announcer'

type WatchCallbacks = Parameters<MobileDesktopRelayHosts['watchChanges']>[2]

const host: DescribedRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Build box',
  health: 'available',
  relay: 'ready',
  environmentId: 'env-1',
  identity: { pairingRevision: 1, runtimeId: 'rt-1' },
  rowChanges: true
}

type StatusListener = Parameters<MobileDesktopRelayHosts['onStatusChanged']>[0]

function fakeHosts() {
  const watches: { callbacks: WatchCallbacks; close: ReturnType<typeof vi.fn> }[] = []
  const status: { listener: StatusListener | null; now: DescribedRelayHost | undefined } = {
    listener: null,
    now: host
  }
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
    status,
    hosts: {
      watchChanges: (_host: unknown, _expected: unknown, callbacks: WatchCallbacks) => {
        const close = vi.fn()
        watches.push({ callbacks, close })
        return { close, current: () => true }
      },
      onStatusChanged: (listener: StatusListener) => {
        status.listener = listener
        return () => {
          status.listener = null
        }
      },
      describe: async () => (status.now ? [status.now] : [])
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

  it('reopens a dropped watch when its server is back, and tells phones', async () => {
    const { hosts, watches, status } = fakeHosts()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(hosts, changed)
    announcer.hold(host, reader('phone-1').reader)
    await vi.runAllTimersAsync()
    // The opening ready is no change.
    watches[0]?.callbacks.onChange({ catalog: true })
    watches[0]?.callbacks.onClose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).not.toHaveBeenCalled()

    status.listener?.({ environmentId: 'env-1', inContact: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(watches).toHaveLength(2)
    // Announced once the new stream is ready, so the phone's read meets a live watch.
    expect(changed).not.toHaveBeenCalled()
    watches[1]?.callbacks.onChange({ catalog: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('opens no watch and announces nothing while a dropped server stays unavailable', async () => {
    const { hosts, watches, status } = fakeHosts()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(hosts, changed)
    announcer.hold(host, reader('phone-1').reader)
    await vi.runAllTimersAsync()
    watches[0]?.callbacks.onClose()
    status.now = { ...host, health: 'disconnected' }
    status.listener?.({ environmentId: 'env-1', inContact: true })
    status.listener?.()
    await vi.advanceTimersByTimeAsync(2000)
    expect(watches).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
  })

  it('announces the ready of a watch whose read fetched rows before the stream was up', async () => {
    const { hosts, watches } = fakeHosts()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(hosts, changed)
    announcer.hold(host, reader('phone-1').reader)
    announcer.refreshed('env-1')
    await vi.runAllTimersAsync()
    watches[0]?.callbacks.onChange({ catalog: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).toHaveBeenCalledTimes(1)

    // A stream that drops and is reopened by the next read announces no ready again.
    watches[0]?.callbacks.onClose()
    announcer.hold(host, reader('phone-1').reader)
    announcer.refreshed('env-1')
    await vi.runAllTimersAsync()
    watches[1]?.callbacks.onChange({ catalog: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('watches no server that publishes no row notices', () => {
    const { hosts, watches } = fakeHosts()
    const announcer = new RelayHostRowsAnnouncer(hosts, vi.fn())
    announcer.hold({ ...host, rowChanges: undefined }, reader('phone-1').reader)
    expect(watches).toHaveLength(0)
  })

  it('moves every phone’s hold to the new watch on a re-pair', async () => {
    const { hosts, watches } = fakeHosts()
    const announcer = new RelayHostRowsAnnouncer(hosts, vi.fn())
    const first = reader('phone-1')
    const second = reader('phone-2')
    announcer.hold(host, first.reader)
    const repaired = { ...host, identity: { pairingRevision: 2, runtimeId: 'rt-1' } }
    announcer.hold(repaired, second.reader)
    await vi.runAllTimersAsync()
    expect(watches).toHaveLength(2)
    expect(watches[0]?.close).toHaveBeenCalledTimes(1)

    second.releases[0]?.()
    expect(watches[1]?.close).not.toHaveBeenCalled()
    first.releases[0]?.()
    expect(watches[1]?.close).toHaveBeenCalledTimes(1)
  })

  it('checks only the named host on keyed status events instead of scanning every held stream', async () => {
    const currentChecks: string[] = []
    const status: { listener: StatusListener | null } = { listener: null }
    const announcer = new RelayHostRowsAnnouncer(
      {
        watchChanges: (target, _expected, _callbacks) => ({
          close: vi.fn(),
          current: () => {
            currentChecks.push(target.environmentId)
            return true
          }
        }),
        onStatusChanged: (listener) => {
          status.listener = listener
          return () => {
            status.listener = null
          }
        },
        describe: async () => []
      },
      vi.fn()
    )
    const phone = reader('phone-1').reader
    announcer.hold(host, phone)
    announcer.hold({ ...host, hostId: 'runtime:env-2', environmentId: 'env-2' }, phone)
    announcer.hold({ ...host, hostId: 'runtime:env-3', environmentId: 'env-3' }, phone)
    await vi.runAllTimersAsync()
    currentChecks.length = 0

    // Offline keyed notice is an immediate O(1) no-op.
    status.listener?.({ environmentId: 'env-2', inContact: false })
    expect(currentChecks).toEqual([])

    // Online keyed notice checks only the named host.
    status.listener?.({ environmentId: 'env-2', inContact: true })
    expect(currentChecks).toEqual(['env-2'])
  })

  it('releases watches immediately on explicit phone release and after an unacknowledged notice', async () => {
    const { hosts, watches } = fakeHosts()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(hosts, changed)
    const phone = reader('phone-1').reader
    announcer.hold(host, phone)
    await vi.runAllTimersAsync()
    expect(watches).toHaveLength(1)

    announcer.release('phone-1')
    expect(watches[0]?.close).toHaveBeenCalledTimes(1)

    // Re-holding opens a fresh watch; if an announcement goes unread, it releases automatically.
    announcer.hold(host, phone)
    await vi.runAllTimersAsync()
    expect(watches).toHaveLength(2)

    watches[1]?.callbacks.onRowsChanged?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(watches[1]?.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(UNACKNOWLEDGED_NOTICE_RELEASE_MS)
    expect(watches[1]?.close).toHaveBeenCalledTimes(1)
  })
})
