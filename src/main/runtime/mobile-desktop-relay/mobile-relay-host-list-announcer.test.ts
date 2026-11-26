import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayHostsListResult } from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { PHONE_LIST_IDLE_MS, RelayHostListAnnouncer } from './mobile-relay-host-list-announcer'

function setup() {
  let statusListener: (() => void) | null = null
  let result: MobileRelayHostsListResult = { hosts: [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the announcer reads only these three listener hooks.
  const hosts = {
    onStatusChanged: (listener: () => void) => {
      statusListener = listener
      return () => {
        statusListener = null
      }
    },
    onEnvironmentRetired: () => () => {},
    onCatalogChanged: () => () => {}
  } as unknown as MobileDesktopRelayHosts
  const changed = vi.fn()
  const announcer = new RelayHostListAnnouncer(hosts, () => result, {
    onClientEvent: () => () => {},
    changed
  })
  const statusChanges = async (next: MobileRelayHostsListResult) => {
    result = next
    statusListener?.()
    await vi.advanceTimersByTimeAsync(0)
  }
  return { announcer, changed, statusChanges }
}

const stopped: MobileRelayHostsListResult = {
  hosts: [{ hostId: 'runtime:wsl', label: 'Ubuntu', health: 'disconnected', relay: 'unavailable' }]
}

describe('RelayHostListAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps announcing to a phone that holds the list past the idle window, until it disconnects', async () => {
    const { announcer, changed, statusChanges } = setup()
    const releases: (() => void)[] = []
    announcer.listed(
      { hosts: [] },
      { connectionId: 'phone-1', onClose: (release) => releases.push(release) }
    )
    await vi.advanceTimersByTimeAsync(PHONE_LIST_IDLE_MS * 2)
    await statusChanges(stopped)
    expect(changed).toHaveBeenCalledTimes(1)

    releases[0]?.()
    await vi.advanceTimersByTimeAsync(PHONE_LIST_IDLE_MS)
    await statusChanges({ hosts: [] })
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
