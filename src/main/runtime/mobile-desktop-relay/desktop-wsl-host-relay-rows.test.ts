import { describe, expect, it, vi } from 'vitest'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../shared/runtime-host-status'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type { ServerWorktreeRows } from './mobile-relay-host-catalog'
import {
  serverRowsWithDesktopWslHostsOnDemand,
  withoutDesktopWslHosts
} from './desktop-wsl-host-relay-rows'

function relayHosts(): MobileDesktopRelayHosts {
  const status = runtimeEnvironmentStatusFromSnapshot({
    environmentId: 'any',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: null,
    verification: 'unavailable',
    transport: 'disconnected'
  })
  return {
    list: () => ({
      environments: [
        { id: 'vm', name: 'VM', pairingRevision: 1, runtimeId: null },
        {
          id: 'wsl:ubuntu',
          name: 'Ubuntu (WSL)',
          orcadDeployment: { kind: 'wsl' },
          pairingRevision: 1,
          runtimeId: null
        }
      ],
      statusByEnvironmentId: new Map([
        ['vm', status],
        ['wsl:ubuntu', status]
      ]),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    }),
    resolve: async () => null,
    call: async () => ({ id: 'x', ok: true, result: null, _meta: { runtimeId: 'r' } }),
    hostsBrowserPage: () => false,
    onEnvironmentRetired: () => () => {},
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => true })
  }
}

function rowsSource(): ServerWorktreeRows & {
  refresh: ReturnType<typeof vi.fn<ServerWorktreeRows['refresh']>>
} {
  return {
    sync: vi.fn(),
    refresh: vi.fn<ServerWorktreeRows['refresh']>(async () => {}),
    rows: () => []
  }
}

describe('desktop WSL hosts on the relay', () => {
  it("keeps the desktop's own WSL hosts out of the sidebar's paired-server view", () => {
    const listing = withoutDesktopWslHosts(relayHosts()).list()
    expect(listing.environments.map((environment) => environment.id)).toEqual(['vm'])
    expect([...listing.statusByEnvironmentId.keys()]).toEqual(['vm'])
  })

  it("fetches a WSL host's rows on demand for a phone, and every other server's from the sidebar", async () => {
    const sidebar = rowsSource()
    const onDemand = rowsSource()
    const rows = serverRowsWithDesktopWslHostsOnDemand(relayHosts(), sidebar, onDemand)
    await rows.refresh('wsl:ubuntu')
    await rows.refresh('vm')
    expect(onDemand.refresh).toHaveBeenCalledWith('wsl:ubuntu')
    expect(sidebar.refresh).toHaveBeenCalledWith('vm')
    expect(onDemand.refresh).toHaveBeenCalledTimes(1)
    expect(sidebar.refresh).toHaveBeenCalledTimes(1)
  })
})
