import { createElement, useState } from 'react'
import { filterWorktrees } from '../worktree/workspace-list-sections'
import { normalizeVisibleExecutionHostIds } from '../../../src/shared/execution-host'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('react-native', () => ({}))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: () => {} }))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import {
  recordHostDescriptor,
  resetHostDescriptorStoreForTests
} from '../transport/host-descriptor-store'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useHostDisplayWorktrees } from './use-host-display-worktrees'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function row(worktreeId: string, hostId?: string): Record<string, unknown> {
  return {
    worktreeId,
    repoId: `repo-${worktreeId}`,
    hostId,
    repo: worktreeId,
    branch: 'main',
    displayName: worktreeId,
    path: `/w/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

const HOSTS = [
  { hostId: 'runtime:vm', label: 'VM', health: 'available', relay: 'ready' },
  { hostId: 'runtime:old', label: 'ThinkPad', health: 'available', relay: 'update-needed' }
]

type Desktop = {
  hostWorktrees?: (hostId: string) => unknown
  carriesRpcEnvelope?: boolean
}

function desktop({ hostWorktrees, carriesRpcEnvelope }: Desktop = {}): FakeSession {
  const client = new FakeSession('connected')
  if (carriesRpcEnvelope !== undefined) {
    Object.assign(client, { carriesRpcEnvelope: () => carriesRpcEnvelope })
  }
  client.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'worktree.ps':
        return reply({ worktrees: [row('mac-wt', 'local')], snapshotId: 's1' })
      case 'mobileRelay.hosts.list':
        return reply({ hosts: HOSTS })
      case 'mobileRelay.hosts.worktrees': {
        const { hostId } = z.object({ hostId: z.string() }).parse(params)
        const result = hostWorktrees
          ? hostWorktrees(hostId)
          : { worktrees: [row(`${hostId}-wt`, hostId)] }
        if (result instanceof Error) {
          throw result
        }
        return reply(result)
      }
      default:
        return reply({})
    }
  })
  return client
}

type Screen = {
  rows: () => Worktree[]
  state: () => ReturnType<typeof useHostScreenState>
  poll: () => Promise<void>
  hideHosts: (ids: string[]) => void
  open: (worktreeId: string) => void
  notice: () => string | null
  catalogError: () => string | null
  pin: (worktreeId: string) => void
  sleep: (worktreeId: string) => void
  slept: () => ReadonlySet<string> | undefined
  serverWorkspaces: () => unknown
  swapClient: (next: RpcClient) => Promise<void>
  navigations: string[]
}

async function mountScreen(first: RpcClient, hostCapabilities: string[]): Promise<Screen> {
  let client = first
  let rerender: (() => void) | null = null
  const navigations: string[] = []
  const router = { push: (to: string) => navigations.push(to), replace: () => {} }
  const held: {
    rows: Worktree[]
    state?: ReturnType<typeof useHostScreenState>
    fetch?: () => Promise<void>
    actions?: ReturnType<typeof useHostWorktreeActions>
  } = { rows: [] }
  function Probe(): null {
    const [, setTick] = useState(0)
    rerender = () => setTick((tick) => tick + 1)
    const state = useHostScreenState('host-1', undefined)
    state.clientRef.current = client
    const catalog = useHostWorktreeCatalog({
      client,
      connState: 'connected',
      embedded: true,
      fetchRepoMetadata: async () => {},
      hostCapabilities,
      hostId: 'host-1',
      state,
      syncViewSettingsFromDesktop: async () => {}
    })
    held.actions = useHostWorktreeActions({
      client,
      connState: 'connected',
      embedded: false,
      fetchWorktrees: catalog.fetchWorktrees,
      forgetHostClient: () => {},
      hostCapabilities,
      hostId: 'host-1',
      pathname: '/h/host-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actions only push and replace.
      router: router as unknown as Parameters<typeof useHostWorktreeActions>[0]['router'],
      state
    })
    held.state = state
    held.fetch = catalog.fetchWorktrees
    held.rows = useHostDisplayWorktrees('connected', state, 'host-1')
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  const poll = async (): Promise<void> => {
    await act(async () => {
      await held.fetch?.()
      await vi.waitFor(() => expect(held.state?.fetchWorktreesInFlightRef.current).toBe(false))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  await poll()
  return {
    rows: () => held.rows,
    state: () => held.state!,
    poll,
    hideHosts: (ids) =>
      act(() =>
        held.state?.setView((view) => ({
          ...view,
          filters: { ...view.filters, visibleHostIds: normalizeVisibleExecutionHostIds(ids) }
        }))
      ),
    open: (worktreeId) =>
      act(() => {
        const item = held.rows.find((entry) => entry.worktreeId === worktreeId)
        held.actions?.openWorktreeSession(item!)
      }),
    notice: () => held.state?.serverNotice ?? null,
    catalogError: () => held.state?.catalogError ?? null,
    pin: (worktreeId) =>
      act(() => {
        held.actions?.togglePin(held.rows.find((entry) => entry.worktreeId === worktreeId)!)
      }),
    sleep: (worktreeId) =>
      act(() => {
        held.actions?.putWorktreeToSleep(
          held.rows.find((entry) => entry.worktreeId === worktreeId)!
        )
      }),
    slept: () => held.state?.sleptIds,
    serverWorkspaces: () => held.state?.serverWorkspaces,
    swapClient: async (next) => {
      client = next
      await act(async () => rerender?.())
    },
    navigations
  }
}

function listed(rows: Worktree[]): [string, string | undefined, string | undefined][] {
  return rows.map((entry) => [entry.worktreeId, entry.hostId, entry.hostContextHealthLabel])
}

function calledMethods(client: FakeSession): string[] {
  return client.sendRequest.mock.calls.map(([method]) => method)
}

describe("a desktop's server workspaces on the phone", () => {
  it('lists each server through the desktop, badged with its own health', async () => {
    const screen = await mountScreen(desktop(), RELAYS)
    expect(listed(screen.rows())).toEqual([
      ['mac-wt', 'local', undefined],
      ['runtime:vm-wt', 'runtime:vm', undefined],
      ['runtime:old-wt', 'runtime:old', 'Update needed']
    ])
    expect(screen.rows().map((entry) => entry.hostContextLabel)).toEqual([
      expect.any(String),
      'VM',
      'ThinkPad'
    ])
  })

  it("names the desktop's own row for the desktop's platform once servers mix the list", async () => {
    recordHostDescriptor('host-1', { machineName: null, platform: 'darwin' })
    try {
      const screen = await mountScreen(desktop(), RELAYS)
      expect(screen.rows()[0]).toMatchObject({
        worktreeId: 'mac-wt',
        hostContextLabel: 'Local Mac'
      })
    } finally {
      resetHostDescriptorStoreForTests()
    }
  })

  it('keeps showing today’s view under an older desktop or an older shell', async () => {
    const oldDesktop = desktop()
    const oldShell = desktop({ carriesRpcEnvelope: false })
    for (const [client, capabilities] of [
      [oldDesktop, []],
      [oldShell, RELAYS]
    ] as const) {
      const screen = await mountScreen(client, [...capabilities])
      expect(listed(screen.rows())).toEqual([['mac-wt', 'local', undefined]])
      expect(calledMethods(client).filter((method) => method.startsWith('mobileRelay.'))).toEqual(
        []
      )
    }
  })

  it('lists them on the page only when its shell carries the envelope', async () => {
    // An app built before `rpcEnvelope` grants everything else, so the page drops just that name.
    const oldApp = (json: string) => json.replace(',"rpcEnvelope"', '')
    for (const [rewriteToPage, expected] of [
      [oldApp, [['mac-wt', 'local', undefined]]],
      [
        undefined,
        [
          ['mac-wt', 'local', undefined],
          ['runtime:vm-wt', 'runtime:vm', undefined],
          ['runtime:old-wt', 'runtime:old', 'Update needed']
        ]
      ]
    ] as const) {
      const shell = desktop()
      const pair = createBridgePortPair({ rpc: shell, ...(rewriteToPage ? { rewriteToPage } : {}) })
      await pair.flush()
      expect(pair.client.carriesRpcEnvelope?.()).toBe(!rewriteToPage)
      const screen = await mountScreen(pair.client, RELAYS)
      await screen.poll()
      expect(listed(screen.rows())).toEqual(expected)
      expect(calledMethods(shell).includes('mobileRelay.hosts.list')).toBe(!rewriteToPage)
    }
  })

  it('shows no server rows, and no error, when the desktop cannot answer the hosts list', async () => {
    const client = desktop()
    const base = client.sendRequest.getMockImplementation()!
    client.sendRequest.mockImplementation(async (method: string, params?: unknown) =>
      method.startsWith('mobileRelay.')
        ? {
            id: 'reply',
            ok: false,
            error: { code: 'method_not_found', message: `Unknown method: ${method}` },
            _meta: { runtimeId: 'runtime' }
          }
        : base(method, params)
    )
    const screen = await mountScreen(client, RELAYS)
    expect(listed(screen.rows())).toEqual([['mac-wt', 'local', undefined]])
    expect(calledMethods(client)).toContain('mobileRelay.hosts.list')
    expect(screen.catalogError()).toBeNull()
  })

  it('keeps a server’s rows when one poll cannot read them, and drops a server the desktop forgot', async () => {
    let failing = false
    const client = desktop({
      hostWorktrees: (hostId) =>
        failing && hostId === 'runtime:vm'
          ? new Error('timed out')
          : { worktrees: [row(`${hostId}-wt`, hostId)] }
    })
    const screen = await mountScreen(client, RELAYS)
    failing = true
    await screen.poll()
    expect(screen.rows().map((entry) => entry.worktreeId)).toContain('runtime:vm-wt')
    // A row naming another host is refused rather than listed under this one.
    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'mobileRelay.hosts.list'
        ? reply({ hosts: [HOSTS[1]] })
        : method === 'mobileRelay.hosts.worktrees'
          ? reply({ worktrees: [row('stray', 'runtime:vm')] })
          : reply({ worktrees: [row('mac-wt', 'local')], snapshotId: 's1' })
    )
    await screen.poll()
    expect(screen.rows().map((entry) => entry.worktreeId)).toEqual(['mac-wt'])
  })

  it('follows the desktop’s hidden hosts, across its own and its servers’ rows', async () => {
    const screen = await mountScreen(desktop(), RELAYS)
    // The list's own filters narrow it, as they narrow the desktop's sidebar.
    const shown = () =>
      filterWorktrees(
        screen.rows(),
        screen.state().view.filters,
        '',
        screen.state().repoHostIdByRepoId
      ).map((entry) => entry.worktreeId)
    screen.hideHosts(['local', 'runtime:old'])
    expect(shown()).toEqual(['mac-wt', 'runtime:old-wt'])
    screen.hideHosts(['runtime:old'])
    expect(shown()).toEqual(['runtime:old-wt'])
  })

  it('opens a ready server workspace there, and explains one that needs an update', async () => {
    const client = desktop()
    const screen = await mountScreen(client, RELAYS)
    screen.open('runtime:vm-wt')
    expect(screen.navigations).toEqual([
      '/h/host-1/session/runtime%3Avm-wt?name=runtime%3Avm-wt&executionHost=runtime%3Avm'
    ])
    await vi.waitFor(() =>
      expect(client.sendRequest).toHaveBeenCalledWith(
        'worktree.activate',
        expect.objectContaining({ worktree: 'id:runtime:vm-wt' }),
        { envelope: { executionHost: 'runtime:vm' } }
      )
    )
    screen.open('runtime:old-wt')
    expect(screen.navigations).toHaveLength(1)
    expect(screen.notice()).toBe('Update Orca on ThinkPad to open its workspaces from your phone.')
  })

  it('opens nothing for a listed server workspace once the phone can no longer reach it', async () => {
    const screen = await mountScreen(desktop(), RELAYS)
    const oldShell = desktop({ carriesRpcEnvelope: false })
    await screen.swapClient(oldShell)
    expect(screen.rows().map((entry) => entry.worktreeId)).toContain('runtime:vm-wt')
    screen.open('runtime:vm-wt')
    expect(screen.navigations).toEqual([])
    expect(calledMethods(oldShell)).not.toContain('worktree.activate')
  })

  it('pins a server workspace on that server, as the desktop does', async () => {
    const client = desktop()
    const screen = await mountScreen(client, RELAYS)
    screen.pin('runtime:vm-wt')
    expect(client.sendRequest).toHaveBeenCalledWith(
      'worktree.set',
      { worktree: 'id:runtime:vm-wt', isPinned: true },
      { envelope: { executionHost: 'runtime:vm' } }
    )
    expect(screen.rows().find((entry) => entry.worktreeId === 'runtime:vm-wt')?.isPinned).toBe(true)
  })

  it('sleeps a desktop workspace on the desktop and shows it slept at once', async () => {
    const client = desktop()
    const screen = await mountScreen(client, RELAYS)
    screen.sleep('mac-wt')
    expect(client.sendRequest).toHaveBeenCalledWith('worktree.sleep', { worktree: 'id:mac-wt' })
    expect(screen.slept()?.size).toBe(1)
  })

  it('reads a replaced client\u2019s servers at once, and keeps an unchanged poll\u2019s list', async () => {
    const stuck = desktop()
    const base = stuck.sendRequest.getMockImplementation()!
    stuck.sendRequest.mockImplementation((method: string, params?: unknown) =>
      method === 'mobileRelay.hosts.list'
        ? new Promise<RpcResponse>(() => {})
        : base(method, params)
    )
    const screen = await mountScreen(stuck, RELAYS)
    const next = desktop()
    await screen.swapClient(next)
    await screen.poll()
    expect(calledMethods(next)).toContain('mobileRelay.hosts.list')
    const listedOnce = screen.serverWorkspaces()
    await screen.poll()
    expect(screen.serverWorkspaces()).toBe(listedOnce)
  })
})
