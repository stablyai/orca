import { createElement, useState } from 'react'

import { normalizeVisibleExecutionHostIds } from '../../../src/shared/execution-host'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('react-native', () => ({ AppState: {} }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: () => {} }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'

import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { Worktree, WorktreeHostContextView } from '../worktree/workspace-list-types'
import {
  NO_WORKTREE_HOST_CONTEXT,
  type WorktreeHostContextOf
} from '../worktree/worktree-host-context-labels'
import { useHostDisplayWorktrees, useResolvedHostPlatform } from './use-host-display-worktrees'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { hostWorktreeCatalogKey } from './host-list-queries'

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  act(() => mounted.splice(0).forEach((renderer) => renderer.unmount()))
})

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

// A display row with the host context the list draws beside it.
type LabelledRow = Worktree & WorktreeHostContextView

type Screen = {
  rows: () => LabelledRow[]
  state: () => ReturnType<typeof useHostScreenState>
  poll: () => Promise<void>
  hideHosts: (ids: string[]) => void
  open: (worktreeId: string) => void
  openRow: (row: LabelledRow) => void
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
    hostContextOf: WorktreeHostContextOf
    state?: ReturnType<typeof useHostScreenState>
    refresh?: () => Promise<void>
    actions?: ReturnType<typeof useHostWorktreeActions>
  } = { rows: [], hostContextOf: NO_WORKTREE_HOST_CONTEXT }
  function Probe(): null {
    const [, setTick] = useState(0)
    rerender = () => setTick((tick) => tick + 1)
    const state = useHostScreenState('host-1')
    state.clientRef.current = client
    const catalog = useHostWorktreeCatalog({
      client,
      connState: 'connected',
      embedded: true,
      hostCapabilities,
      hostId: 'host-1',
      sidebarFeed: null,
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
    held.refresh = catalog.onRefresh
    const display = useHostDisplayWorktrees(
      'connected',
      state,
      useResolvedHostPlatform(state, 'host-1')
    )
    held.rows = display.worktrees
    held.hostContextOf = display.hostContextOf
    return null
  }
  const queryClient = createOrcaQueryClient()
  await act(async () => {
    mounted.push(
      create(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)))
    )
  })
  // Reads the host list again, as pull to refresh does; the catalog's interval does the same.
  const poll = async (): Promise<void> => {
    await act(async () => {
      void held.refresh?.()
      const catalog = { queryKey: hostWorktreeCatalogKey('host-1') }
      await vi.waitFor(() => expect(queryClient.isFetching(catalog)).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  await poll()
  return {
    rows: () => held.rows.map((row) => ({ ...row, ...held.hostContextOf(row) })),
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
    openRow: (row) => act(() => held.actions?.openWorktreeSession(row)),
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

function listed(rows: LabelledRow[]): [string, string | undefined, string | undefined][] {
  return rows.map((entry) => [entry.worktreeId, entry.hostId, entry.hostContextHealthLabel])
}

function calledMethods(client: FakeSession): string[] {
  return client.sendRequest.mock.calls.map(([method]) => method)
}

describe("a desktop's server workspaces on the phone", () => {
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
    const listedRow = screen.rows().find((entry) => entry.worktreeId === 'runtime:vm-wt')!
    const oldShell = desktop({ carriesRpcEnvelope: false })
    await screen.swapClient(oldShell)
    expect(screen.rows().map((entry) => entry.worktreeId)).not.toContain('runtime:vm-wt')
    // A tap on the row still drawn from before the swap.
    screen.openRow(listedRow)
    expect(screen.navigations).toEqual([])
    expect(calledMethods(oldShell)).not.toContain('worktree.activate')
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
