import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

const feed = vi.hoisted((): { hosts: readonly MobileRelayHost[] | null } => ({ hosts: null }))
const gatesConnStates = vi.hoisted((): ConnectionState[] => [])

vi.mock('../worktree/relay-hosts-feed', () => ({ useRelayHosts: () => feed.hosts }))
vi.mock('./execution-host-scoped-rpc-client', () => ({
  workspaceRouteExecutionHost: (_client: unknown, _caps: unknown, host: string) => host,
  scopeRpcClientToExecutionHost: (client: RpcClient) => client
}))
vi.mock('./host-status-gates', () => ({
  useHostStatusGates: (args: { connState: ConnectionState }) => {
    gatesConnStates.push(args.connState)
    return {}
  }
}))

const { useWorkspaceServer } = await import('./workspace-server')

const HOST = 'runtime:server-1' as const

function server(relay: MobileRelayHost['relay']): MobileRelayHost {
  return { hostId: HOST, label: 'Server', health: 'available', relay }
}

describe('useWorkspaceServer', () => {
  it("re-reads the server's status when the server reconnects under a connected desktop", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked route and gates never call the client.
    const client = {} as RpcClient
    function Probe(): null {
      useWorkspaceServer({
        client,
        connState: 'connected',
        desktopCapabilities: [],
        executionHost: HOST
      })
      return null
    }
    feed.hosts = [server('ready')]
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    feed.hosts = [server('unavailable')]
    await act(async () => {
      renderer?.update(createElement(Probe))
    })
    feed.hosts = [server('ready')]
    await act(async () => {
      renderer?.update(createElement(Probe))
    })
    // The gates' status read is keyed on this state, so the restart must reach it.
    expect(gatesConnStates).toEqual(['connected', 'connecting', 'connected'])
    renderer?.unmount()
  })
})
