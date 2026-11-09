import { createElement, Fragment } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEventStreamMessage } from '../../../../src/shared/runtime-client-events'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list-types'
import type * as MobileWorkspaceLineage from '../../worktree/mobile-workspace-lineage'
import type * as FolderLineageSerialization from './folder-lineage-serialization'
import type { MobileRelayHost } from '../../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../../src/shared/mobile-desktop-relay-contract'
import { HOST_LIST_TARGET, hostServerWorkspacesQuery } from '../../host-screen/host-list-queries'
import { hostQueryKey } from '../../query/host-query-key'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../../test-support/rpc-recording/hook-mount'
import {
  useMobileFolderAttachedWorktrees,
  type MobileFolderAttachedWorktrees
} from './use-mobile-folder-attached-worktrees'
import { MobileFolderWorktreeRow } from './MobileFolderWorktreeRow'

vi.mock('react-native', () => ({ AppState: {} }))
const gates = vi.hoisted(() => {
  const hostCapabilities: string[] = []
  return { hostCapabilities }
})
vi.mock('../../components/host-protocol-gates-context', () => ({
  useOptionalHostProtocolGates: () => gates
}))
const host = vi.hoisted(() => {
  const state: { client: unknown } = { client: null }
  return state
})
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useHostClient: () => ({ client: host.client, clientId: 'client-1', state: 'connected' })
}))
const lineage = vi.hoisted(() => ({ resolutions: 0, serialized: 0, rowCommits: 0 }))
vi.mock('../../worktree/mobile-workspace-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof MobileWorkspaceLineage>()
  return {
    ...actual,
    getMobileWorkspaceLineageChildren: (
      ...args: Parameters<typeof actual.getMobileWorkspaceLineageChildren>
    ) => {
      lineage.resolutions += 1
      return actual.getMobileWorkspaceLineageChildren(...args)
    }
  }
})
// Runs behind the production key cache, so each call is a row serialized.
vi.mock('./folder-lineage-serialization', async (importOriginal) => {
  const actual = await importOriginal<typeof FolderLineageSerialization>()
  return {
    serializeFolderLineage: (row: Worktree) => {
      lineage.serialized += 1
      return actual.serializeFolderLineage(row)
    }
  }
})
// Inside the production row's memo boundary: each call is a committed row render.
vi.mock('../../components/list/ListGroup', () => ({
  ListRow: () => {
    lineage.rowCommits += 1
    return null
  }
}))
vi.mock('./use-folder-worktree-status', () => ({
  useFolderWorktreeStatus: () => NO_STATUS
}))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
const NO_STATUS = vi.hoisted(() => ({ data: undefined, error: null }))
const REFRESHERS = new Set<() => void>()
const NOOP = (): void => {}

const READY: RuntimeClientEventStreamMessage = { type: 'ready', subscriptionId: 'sub-1' }

function row(worktreeId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId,
    repoId: worktreeId.split('::')[0],
    repo: 'api',
    branch: 'feature',
    displayName: worktreeId,
    path: `/src/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

/** H host rows: the folder, N attached worktrees, and unrelated ones. */
function catalog(h: number, n: number, edit: (rows: Worktree[]) => void = () => {}): Worktree[] {
  const rows = [row('folder:f-1', { workspaceKind: 'folder-workspace' })]
  for (let i = 0; i < n; i++) {
    rows.push(
      row(`repo-a::/w${i}`, {
        workspaceLineage: { parentWorkspaceKey: 'folder:f-1', parentInstanceId: null }
      })
    )
  }
  for (let i = rows.length; i < h; i++) {
    rows.push(row(`repo-b::/other${i}`))
  }
  edit(rows)
  return rows
}

function catalogHost(initial: Worktree[]) {
  let rows = initial
  let emit: (event: RuntimeClientEventStreamMessage) => void = () => {}
  const client: RpcClient = stubRpcClient({
    getLastConnectedAt: () => 1,
    sendRequest: async (method) => ({
      id: 'call',
      ok: true,
      result: method === 'worktree.ps' ? { worktrees: rows } : {},
      _meta: { runtimeId: 'runtime-1' }
    }),
    subscribe: (method, _params, onEvent) => {
      if (method === 'runtime.clientEvents.subscribe') {
        emit = (event) => onEvent(event)
      }
      return () => {}
    }
  })
  return {
    client,
    setRows: (next: Worktree[]) => {
      rows = next
    },
    emit: (event: RuntimeClientEventStreamMessage) => emit(event)
  }
}

let renderer: ReactTestRenderer | null = null
const queries = documentQueryClient()

afterEach(async () => {
  gates.hostCapabilities = []
  act(() => renderer?.unmount())
  renderer = null
  await queries.end()
  vi.useRealTimers()
})

let queryClient: QueryClient | null = null

async function mount(read: { current: MobileFolderAttachedWorktrees | null }) {
  function Harness() {
    queryClient = useQueryClient()
    const folder = useMobileFolderAttachedWorktrees('host-1', 'folder:f-1', true)
    read.current = folder
    return createElement(
      Fragment,
      null,
      folder.worktrees.map((worktree) =>
        createElement(MobileFolderWorktreeRow, {
          key: worktree.worktreeId,
          hostId: 'host-1',
          desktopCapabilities: folder.desktopCapabilities,
          worktree,
          unreachable: false,
          subscribed: true,
          refreshers: REFRESHERS,
          onOpen: NOOP
        })
      )
    )
  }
  await act(async () => {
    renderer = create(queries.wrap(createElement(Harness)))
  })
  await settleQueryNotifications()
}

async function rowsChanged(fake: ReturnType<typeof catalogHost>, next: Worktree[]) {
  fake.setRows(next)
  // Past the catalog's three-second signal floor.
  vi.setSystemTime(Date.now() + 5_000)
  await act(async () => fake.emit({ type: 'worktreeRowsChanged' }))
  await settleQueryNotifications()
}

function churn(rows: Worktree[]): void {
  const h = rows.length
  rows[1] = { ...rows[1], liveTerminalCount: 3, unread: true }
  rows[h - 1] = { ...rows[h - 1], status: 'working' }
  rows[h - 2] = { ...rows[h - 2], displayName: 'elsewhere', branch: 'other' }
}

function rename(rows: Worktree[]): void {
  rows[2] = { ...rows[2], displayName: 'renamed', branch: 'renamed-branch' }
}

describe.each([
  { h: 750, n: 30 },
  { h: 7_500, n: 300 }
])('folder membership over H=$h host rows, N=$n attached', ({ h, n }) => {
  it('resolves lineage only for lineage changes, serializing and committing only changed rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fake = catalogHost(catalog(h, n))
    host.client = fake.client
    const read: { current: MobileFolderAttachedWorktrees | null } = { current: null }
    await mount(read)
    fake.emit(READY)
    await settleQueryNotifications()
    expect(read.current?.worktrees).toHaveLength(n)
    const members = read.current!.worktrees
    lineage.resolutions = 0
    lineage.serialized = 0
    lineage.rowCommits = 0

    // Agent attention and terminal counts on a member and an unrelated row, and an unrelated rename.
    await rowsChanged(fake, catalog(h, n, churn))
    expect(lineage.resolutions).toBe(0)
    expect(lineage.serialized).toBe(3)
    expect(lineage.rowCommits).toBe(0)
    expect(read.current?.worktrees).toBe(members)

    // A member renamed: shown at once, without resolving lineage or touching the other members.
    lineage.serialized = 0
    await rowsChanged(
      fake,
      catalog(h, n, (rows) => {
        churn(rows)
        rename(rows)
      })
    )
    expect(lineage.resolutions).toBe(0)
    expect(lineage.serialized).toBe(1)
    expect(lineage.rowCommits).toBe(1)
    const renamed = read.current!.worktrees
    expect(renamed[1]).toMatchObject({ displayName: 'renamed', branch: 'renamed-branch' })
    expect(renamed.filter((member, index) => member !== members[index])).toHaveLength(1)

    // A worktree attached: membership follows.
    await rowsChanged(
      fake,
      catalog(h, n, (rows) => {
        churn(rows)
        rename(rows)
        rows[h - 1] = {
          ...rows[h - 1],
          workspaceLineage: { parentWorkspaceKey: 'folder:f-1', parentInstanceId: null }
        }
      })
    )
    expect(lineage.resolutions).toBe(1)
    expect(read.current?.worktrees).toHaveLength(n + 1)
  })

  it('resolves lineage again for a server store change, not for its health', async () => {
    gates.hostCapabilities = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    const fake = catalogHost(catalog(h, n))
    host.client = fake.client
    const read: { current: MobileFolderAttachedWorktrees | null } = { current: null }
    await mount(read)
    const serversKey = hostQueryKey('host-1', hostServerWorkspacesQuery.family, HOST_LIST_TARGET, {
      deltas: false
    })
    const servers = (overrides: Partial<MobileRelayHost>) => ({
      hosts: Array.from({ length: 30 }, (_, i) => ({
        hostId: `runtime:env-${i}` as const,
        label: `env ${i}`,
        health: 'available' as const,
        relay: 'ready' as const,
        installationId: `install-${i}`,
        ...(i === 0 ? overrides : {})
      })),
      worktrees: []
    })
    const setServers = async (overrides: Partial<MobileRelayHost>) => {
      await act(async () => {
        queryClient!.setQueryData(serversKey, servers(overrides))
      })
      await settleQueryNotifications()
    }
    await setServers({})
    expect(read.current?.worktrees).toHaveLength(n)
    const members = read.current!.worktrees
    lineage.resolutions = 0

    await setServers({ health: 'connecting', relay: 'unavailable' })
    expect(lineage.resolutions).toBe(0)
    expect(read.current?.worktrees).toBe(members)

    await setServers({ installationId: 'install-new' })
    expect(lineage.resolutions).toBe(1)
  })
})
