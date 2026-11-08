import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEventStreamMessage } from '../../../../src/shared/runtime-client-events'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list-types'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../../test-support/rpc-recording/hook-mount'
import {
  useMobileFolderAttachedWorktrees,
  type MobileFolderAttachedWorktrees
} from './use-mobile-folder-attached-worktrees'

vi.mock('react-native', () => ({ AppState: {} }))
const host = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useHostClient: () => ({ client: host.client, clientId: 'client-1', state: 'connected' })
}))
const lineage = vi.hoisted(() => ({ resolutions: 0 }))
vi.mock('../../worktree/mobile-workspace-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worktree/mobile-workspace-lineage')>()
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
  act(() => renderer?.unmount())
  renderer = null
  await queries.end()
  vi.useRealTimers()
})

async function mount(read: { current: MobileFolderAttachedWorktrees | null }) {
  function Harness(): null {
    read.current = useMobileFolderAttachedWorktrees('host-1', 'folder:f-1', true)
    return null
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

describe.each([
  { h: 750, n: 30 },
  { h: 7_500, n: 300 }
])('folder membership over H=$h host rows, N=$n attached', ({ h, n }) => {
  it('rebuilds lineage only when lineage or a shown label changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fake = catalogHost(catalog(h, n))
    host.client = fake.client
    const read: { current: MobileFolderAttachedWorktrees | null } = { current: null }
    await mount(read)
    fake.emit({ type: 'ready' } as RuntimeClientEventStreamMessage)
    await settleQueryNotifications()
    expect(read.current?.worktrees).toHaveLength(n)
    const members = read.current?.worktrees
    lineage.resolutions = 0

    // Agent attention and terminal counts on unrelated rows and on members.
    await rowsChanged(
      fake,
      catalog(h, n, (rows) => {
        rows[1] = { ...rows[1], liveTerminalCount: 3, unread: true }
        rows[h - 1] = { ...rows[h - 1], status: 'working' }
      })
    )
    expect(lineage.resolutions).toBe(0)
    expect(read.current?.worktrees).toBe(members)

    // A member renamed: the list must show it.
    await rowsChanged(
      fake,
      catalog(h, n, (rows) => {
        rows[1] = { ...rows[1], displayName: 'renamed' }
      })
    )
    expect(lineage.resolutions).toBe(1)
    expect(read.current?.worktrees.some((member) => member.displayName === 'renamed')).toBe(true)
  })
})
