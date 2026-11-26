import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY
} from '../../../../src/shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
const readServers = vi.hoisted(() => vi.fn(async () => ({ hosts: [], worktrees: [] })))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../../query/host-status-query', () => ({
  readHostStatusReply: async () => ({})
}))
vi.mock('../../transport/connection/host-status-probe-operations', () => ({
  readProbedHostStatus: () => ({ status: { capabilities: status.capabilities } })
}))
vi.mock('../../host-screen/catalog/host-list-queries', () => ({
  HOME_WORKTREE_COUNTS_FAMILY: 'worktreeCounts',
  readHostServerWorkspaces: readServers
}))

const { homeServerAgentsQuery } = await import('./home-host-worktree-fetch')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch hands the client only to the mocked status and server reads.
const client = {} as RpcClient
const fetchOnce = () =>
  homeServerAgentsQuery.fetch(client, { exec: 'local' }, {}, undefined, {
    live: false,
    previousFromStore: false,
    hostId: 'desk-a'
  })

describe('Home relayed server agents read', () => {
  beforeEach(() => {
    readServers.mockClear()
  })

  it('re-reads only on desktop change events, never on a timer', () => {
    expect(homeServerAgentsQuery).not.toHaveProperty('refetchInterval')
    expect(homeServerAgentsQuery.signal?.events).toContain('relayHostRowsChanged')
  })

  it('reads no server rows from a desktop that does not announce their changes', async () => {
    status.capabilities = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    await fetchOnce()
    expect(readServers).not.toHaveBeenCalled()

    status.capabilities = [
      MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
      MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY
    ]
    await fetchOnce()
    expect(readServers).toHaveBeenCalledTimes(1)
  })
})
