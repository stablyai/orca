import { createElement, useContext, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const route = vi.hoisted(() => {
  const state: {
    params: Record<string, string>
    client: unknown
    seen: (string | undefined)[]
    shellRoutes: { params?: Record<string, string> }[]
    redirects: { params: Record<string, string | undefined> }[]
  } = {
    params: {},
    client: null,
    seen: [],
    shellRoutes: [],
    redirects: []
  }
  return state
})

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => route.params,
  useRouter: () => ({ setParams: () => {}, replace: () => {} }),
  Redirect: ({ href }: { href: { params: Record<string, string | undefined> } }) => {
    route.redirects.push(href)
    return null
  }
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable'
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: route.client, state: 'connected' })
}))
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
vi.mock('./route-handoff', () => ({ useRouteHandoff: () => ({ replace: () => {} }) }))
vi.mock('../mobile-web-shell/ShellSwitchPendingScreen', () => ({
  ShellSwitchPendingScreen: () => null
}))
vi.mock('../mobile-web-shell/MobileWebShellScreen', () => ({
  MobileWebShellScreen: ({ route: shellRoute }: { route: { params?: Record<string, string> } }) => {
    route.shellRoutes.push(shellRoute)
    return createElement(Probe)
  }
}))
vi.mock('../files/MobileFileExplorerPanel', () => ({ MobileFileExplorerPanel: Probe }))
vi.mock('../files/MobileFilePreviewScreen', () => ({ MobileFilePreviewScreen: Probe }))
vi.mock('../source-control/MobileSourceControlPanel', () => ({ MobileSourceControlPanel: Probe }))
vi.mock('../session/MobileDiffReviewRouteScreen', () => ({ MobileDiffReviewRouteScreen: Probe }))
vi.mock('../session/MobileSessionRouteScreen', () => ({ MobileSessionRouteScreen: Probe }))
vi.mock('../agent-history/MobileAgentSessionHistoryPanel', () => ({
  MobileAgentSessionHistoryPanel: Probe
}))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import {
  HostStatusGatesContext,
  useOptionalHostProtocolGates
} from '../components/host-protocol-gates-context'
import {
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  type MobileRelayHost
} from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { ConnectionState } from '../transport/types'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { WorkspaceServerContext } from '../transport/workspace-server-context'
import { useWorkspaceExecutionHost } from './workspace-execution-host'
import { WorkspaceRoute } from './workspace-route'
import { documentQueryClient } from '../test-support/rpc-recording/hook-mount'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]

const below: {
  client: RpcClient | null
  state: ConnectionState | null
  capabilities: readonly string[] | null
  serverName: string | null
} = {
  client: null,
  state: null,
  capabilities: null,
  serverName: null
}

function Probe(): null {
  route.seen.push(useWorkspaceExecutionHost())
  const workspace = useWorkspaceClient('host-1')
  below.client = workspace.client
  below.state = workspace.state
  below.capabilities = useOptionalHostProtocolGates()?.hostCapabilities ?? null
  below.serverName = useContext(WorkspaceServerContext)?.name ?? null
  return null
}

function desktopGates(hostCapabilities: string[], statusPending = false): HostStatusGates {
  return {
    hostCapabilities,
    floatingWorkspaceEnabled: false,
    desktopAppVersion: null,
    compatVerdict: { kind: 'ok' },
    hostProtocolWindow: { protocolVersion: undefined, minCompatibleMobileVersion: undefined },
    statusPending,
    statusReadable: true
  }
}

type ServerReport = Pick<MobileRelayHost, 'health' | 'relay'>
const RUNNING: ServerReport = { health: 'available', relay: 'ready' }
const STOPPED: ServerReport = { health: 'connecting', relay: 'unavailable' }
const NO_STATUS_YET: ServerReport = { health: 'available', relay: 'unavailable' }
const FAILED: ServerReport = { health: 'error', relay: 'unavailable' }
const TOO_OLD: ServerReport = { health: 'connecting', relay: 'update-needed' }

const serverReport: { current: ServerReport } = { current: RUNNING }

function desktop(serverCapabilities: string[] = []): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockImplementation(async (method: string) => ({
    id: 'reply',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: serverCapabilities }
        : method === MOBILE_RELAY_HOSTS_LIST_METHOD
          ? {
              hosts: [{ hostId: 'runtime:vm', label: 'vm', ...serverReport.current }]
            }
          : {},
    _meta: { runtimeId: 'runtime-1' }
  }))
  route.client = session
  return session
}

const trees: ReactTestRenderer[] = []
const pairs: ReturnType<typeof createBridgePortPair>[] = []

afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
  for (const pair of pairs.splice(0)) {
    pair.client.close()
    await pair.flush()
    pair.host.dispose()
  }
})

async function render(element: ReactElement, gates: HostStatusGates): Promise<ReactTestRenderer> {
  route.seen.length = 0
  route.shellRoutes.length = 0
  route.redirects.length = 0
  below.client = null
  below.state = null
  below.capabilities = null
  below.serverName = null
  serverReport.current = RUNNING
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(
      documentQueryClient().wrap(
        createElement(HostStatusGatesContext.Provider, { value: gates }, element)
      )
    )
  })
  if (!renderer) {
    throw new Error('did not render')
  }
  trees.push(renderer)
  return renderer
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
}

describe('a server workspace', () => {
  const screen = createElement(WorkspaceRoute, null, createElement(Probe))

  it('runs every call on that server', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const session = desktop()
    await render(screen, desktopGates(RELAYS))
    expect(below.serverName).toBe('vm')
    await below.client?.sendRequest('files.readDir', { worktree: 'id:wt' })
    expect(session.sendRequest).toHaveBeenCalledWith(
      'files.readDir',
      { worktree: 'id:wt' },
      { envelope: { executionHost: 'runtime:vm' } }
    )
  })

  it.each([
    ['connecting while the desktop reconnects to a stopped server', STOPPED, 'connecting'],
    [
      'connecting while a reached server has not answered its status yet',
      NO_STATUS_YET,
      'connecting'
    ],
    ['disconnected once the desktop gives up on the server', FAILED, 'disconnected'],
    [
      'disconnected while the server is too old to relay to, whatever its health',
      TOO_OLD,
      'disconnected'
    ]
  ] as const)('reads as %s, and recovers', async (_why, report, expected) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
      desktop()
      await render(screen, desktopGates(RELAYS))
      expect(below.state).toBe('connected')
      serverReport.current = report
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(below.state).toBe(expected)
      serverReport.current = RUNNING
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(below.state).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so for a deep link under an app without the envelope, never running on the desktop', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const shell = desktop()
    // Older shells lack rpcEnvelope; preserve every other granted capability while dropping that unsupported token.
    const pair = createBridgePortPair({
      rpc: shell,
      rewriteToPage: (json) => json.replace(',"rpcEnvelope"', '')
    })
    pairs.push(pair)
    await pair.flush()
    expect(pair.client.carriesRpcEnvelope?.()).toBe(false)
    route.client = pair.client
    const renderer = await render(screen, desktopGates(RELAYS))
    await pair.flush()
    expect(route.seen).toEqual([])
    expect(texts(renderer)).toContain(
      "Your phone can't reach this workspace's server through this desktop."
    )
    expect(shell.sendRequest).not.toHaveBeenCalled()
  })
})
