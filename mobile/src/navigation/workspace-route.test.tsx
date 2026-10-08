import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

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
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable'
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: route.client, state: 'connected' })
}))
// The server's status is read for real; only the desktop's persisted records are stubbed.
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
vi.mock('./route-handoff', () => ({ useRouteHandoff: () => ({ replace: () => {} }) }))
// The native switch always hands the page its route, so the census reads what the page is told.
vi.mock('../mobile-web-shell/shell-switch-decision', () => ({
  useShellSwitchDecision: (shellRoute: unknown) =>
    shellRoute ? { kind: 'shell', route: shellRoute } : { kind: 'native' }
}))
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
import type { HostStatusGates } from '../transport/host-status-gates'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useWorkspaceExecutionHost } from './workspace-execution-host'
import { WorkspaceRoute } from './workspace-route'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
const VAULT = 'aiVault.v1'

/** What a screen under the route sees: its server, its client and its feature gates. */
const below: { client: RpcClient | null; capabilities: readonly string[] | null } = {
  client: null,
  capabilities: null
}

function Probe(): null {
  route.seen.push(useWorkspaceExecutionHost())
  below.client = useWorkspaceClient('host-1').client
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

/** A desktop whose own status is settled as given; a status it is asked for is the server's. */
function desktop(serverCapabilities: string[] = []): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockImplementation(async (method: string) => ({
    id: 'reply',
    ok: true,
    result: method === 'status.get' ? { capabilities: serverCapabilities } : {},
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

async function render(element: ReactElement, gates: HostStatusGates): Promise<ReactTestRenderer> {
  route.seen.length = 0
  route.shellRoutes.length = 0
  route.redirects.length = 0
  below.client = null
  below.capabilities = null
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(HostStatusGatesContext.Provider, { value: gates }, element))
  })
  if (!renderer) {
    throw new Error('did not render')
  }
  return renderer
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
}

describe('every workspace route', () => {
  it('is found on disk', () => {
    expect(WORKSPACE_ROUTE_FILES.length).toBeGreaterThanOrEqual(14)
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
      { executionHost: 'runtime:vm' }
    )
  })

  it('gates its features on that server’s own status, not the desktop’s', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    const session = desktop([])
    await render(screen, desktopGates([...RELAYS, VAULT]))
    await vi.waitFor(() => expect(below.capabilities).toEqual([]))
    expect(session.sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      executionHost: 'runtime:vm'
    })
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
    expect(below.capabilities).toEqual([...RELAYS, VAULT])
  })
})
