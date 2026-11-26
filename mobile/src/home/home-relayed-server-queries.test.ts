import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY
} from '../../../src/shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { HostSignalEvent } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
const readHosts = vi.hoisted(() => vi.fn(async () => []))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: {} }))
vi.mock('../query/host-status-query', () => ({ readHostStatusReply: async () => ({}) }))
vi.mock('../transport/connection/host-status-probe-operations', () => ({
  readProbedHostStatus: () => ({ status: { capabilities: status.capabilities } })
}))
vi.mock('../worktree/execution-hosts/relay-hosts-feed', () => ({
  relayHostsFeed: () => ({ read: readHosts })
}))

const { homeRelayedServerRowsQuery, homeRelayedServersQuery, relayedServerRowsPollMs } =
  await import('./home-relayed-server-queries')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch hands the client only to the mocked status and host reads.
const client = {} as RpcClient
const read = { live: false, previousFromStore: false, hostId: 'desk-a' }

describe('Home relayed server reads', () => {
  beforeEach(() => {
    readHosts.mockClear()
  })

  it('re-reads a server only for its own row notice, never on a timer', () => {
    const signal = homeRelayedServerRowsQuery.signal
    const notice: HostSignalEvent = { type: 'relayHostRowsChanged', hostId: 'runtime:a' }
    expect(homeRelayedServerRowsQuery).not.toHaveProperty('refetchInterval')
    expect(homeRelayedServersQuery).not.toHaveProperty('refetchInterval')
    expect(signal?.events).toContain('relayHostRowsChanged')
    expect(signal?.matches?.(notice, { exec: 'runtime:a' })).toBe(true)
    expect(signal?.matches?.(notice, { exec: 'runtime:b' })).toBe(false)
    // A host list change re-reads no server whose read is already mounted.
    expect(signal?.events).not.toContain('relayHostsChanged')
    expect(relayedServerRowsPollMs({ rowChanges: true })).toBe(false)
  })

  it('backs up a server that publishes no row notices with the workspace list’s slow poll', () => {
    expect(relayedServerRowsPollMs({})).toBe(60_000)
  })

  it('reads no relayed servers from a desktop that does not announce their changes', async () => {
    status.capabilities = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    await homeRelayedServersQuery.fetch(client, { exec: 'local' }, {}, undefined, read)
    expect(readHosts).not.toHaveBeenCalled()

    status.capabilities = [
      MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
      MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY
    ]
    await homeRelayedServersQuery.fetch(client, { exec: 'local' }, {}, undefined, read)
    expect(readHosts).toHaveBeenCalledTimes(1)
  })
})
