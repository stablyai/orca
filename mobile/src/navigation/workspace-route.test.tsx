import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
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
// The server's status is read for real; only the desktop's persisted records are stubbed.
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
// Each workspace screen stands in as a probe reporting the server its subtree names.
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
} from '../../../src/shared/mobile-relay-hosts-contract'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { ConnectionState } from '../transport/types'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useWorkspaceExecutionHost } from './workspace-execution-host'
import { WorkspaceRoute } from './workspace-route'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
const VAULT = 'aiVault.v1'

/** What a screen under the route sees: its server, its client and its feature gates. */
const below: {
  client: RpcClient | null
  state: ConnectionState | null
  capabilities: readonly string[] | null
} = {
  client: null,
  state: null,
  capabilities: null
}

function Probe(): null {
  route.seen.push(useWorkspaceExecutionHost())
  const workspace = useWorkspaceClient('host-1')
  below.client = workspace.client
  below.state = workspace.state
  below.capabilities = useOptionalHostProtocolGates()?.hostCapabilities ?? null
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
// The pairs the desktop's `mobileRelay.hosts.list` actually sends for a server.
const RUNNING: ServerReport = { health: 'available', relay: 'ready' }
const STOPPED: ServerReport = { health: 'connecting', relay: 'unavailable' }
const NO_STATUS_YET: ServerReport = { health: 'available', relay: 'unavailable' }
const FAILED: ServerReport = { health: 'error', relay: 'unavailable' }
const TOO_OLD: ServerReport = { health: 'connecting', relay: 'update-needed' }

/** The server as the desktop reports it in `mobileRelay.hosts.list`. */
const serverReport: { current: ServerReport } = { current: RUNNING }

/** A desktop whose own status is settled as given; a status it is asked for is the server's. */
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

const HOST_ROUTES = fileURLToPath(new URL('../../app/h/[hostId]/', import.meta.url))
// Every screen keyed by a workspace, native and page, found on disk so a new one is counted.
const WORKSPACE_ROUTE_FILES = readdirSync(HOST_ROUTES, { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.replaceAll('\\', '/'))
  .filter((entry) => /(^|\/)\[worktreeId\](\.web)?\.tsx$/.test(entry))
  .sort()

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
  serverReport.current = RUNNING
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(HostStatusGatesContext.Provider, { value: gates }, element))
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

describe('every workspace route', () => {
  it('is found on disk', () => {
    expect(WORKSPACE_ROUTE_FILES.length).toBeGreaterThan(0)
  })

  it.each(WORKSPACE_ROUTE_FILES)('keeps %s on the server its route names', async (file) => {
    route.params = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'README.md',
      // Spelled loosely, so a screen reading the raw param instead of its route is caught.
      executionHost: ' runtime:vm '
    }
    desktop()
    const Screen = (await import(/* @vite-ignore */ `${HOST_ROUTES}${file}`)).default
    await render(createElement(Screen), desktopGates(RELAYS))
    if (route.redirects.length > 0) {
      expect(route.redirects.map((href) => href.params.executionHost?.trim())).toEqual([
        'runtime:vm'
      ])
      return
    }
    expect([...new Set(route.seen)]).toEqual(['runtime:vm'])
    for (const shellRoute of route.shellRoutes) {
      expect(shellRoute.params?.executionHost).toBe('runtime:vm')
    }
  })
})

describe('a server workspace', () => {
  const screen = createElement(WorkspaceRoute, null, createElement(Probe))

  it('runs every call on that server', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const session = desktop()
    await render(screen, desktopGates(RELAYS))
    await below.client?.sendRequest('files.readDir', { worktree: 'id:wt' })
    expect(session.sendRequest).toHaveBeenCalledWith(
      'files.readDir',
      { worktree: 'id:wt' },
      { envelope: { executionHost: 'runtime:vm' } }
    )
  })

  it('gates its features on that server’s own status, not the desktop’s', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const serverCapability = 'server-feature.v1'
    const session = desktop([serverCapability])
    await render(screen, desktopGates([...RELAYS, VAULT]))
    await vi.waitFor(() => expect(below.capabilities).toEqual([serverCapability]))
    expect(session.sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      envelope: { executionHost: 'runtime:vm' }
    })
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

  it('opens disconnected, not loading, when its server is already down', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    desktop()
    serverReport.current = FAILED
    await act(async () => {
      trees.push(
        create(
          createElement(HostStatusGatesContext.Provider, { value: desktopGates(RELAYS) }, screen)
        )
      )
    })
    expect(below.state).toBe('disconnected')
  })

  it('says so once the desktop has answered that it cannot reach the server', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const session = desktop()
    const renderer = await render(screen, desktopGates([]))
    expect(route.seen).toEqual([])
    expect(texts(renderer)).toContain(
      "Your phone can't reach this workspace's server through this desktop."
    )
    expect(session.sendRequest).not.toHaveBeenCalled()
  })

  it('says so for a deep link under an app without the envelope, never running on the desktop', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const shell = desktop()
    // An app built before `rpcEnvelope` grants everything else, so the page drops just that name.
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

  it('waits, never on the desktop, while the desktop has not answered', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const session = desktop()
    await render(screen, desktopGates([], true))
    expect([...new Set(route.seen)]).toEqual(['runtime:vm'])
    expect(below.client).toBeNull()
    expect(session.sendRequest).not.toHaveBeenCalled()
  })
})

describe('the desktop’s own workspace', () => {
  it('keeps the desktop’s client and gates', async () => {
    route.params = { hostId: 'host-1' }
    const session = desktop()
    await render(
      createElement(WorkspaceRoute, null, createElement(Probe)),
      desktopGates([...RELAYS, VAULT])
    )
    expect([...new Set(route.seen)]).toEqual([undefined])
    expect(below.client).toBe(session)
    expect(below.state).toBe('connected')
    expect(below.capabilities).toEqual([...RELAYS, VAULT])
    expect(session.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
      MOBILE_RELAY_HOSTS_LIST_METHOD
    )
  })
})
