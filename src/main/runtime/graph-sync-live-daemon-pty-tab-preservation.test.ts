import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
/** Daemon-shaped ids rely on persisted host bindings to survive renderer omission.
 * User close must release those bindings; these cases cover connected/exited, never unverifiable PTYs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { committingSpawn } from './bind-first-pane.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const REPO_ID = 'repo-1'
const WT_CLI = `${REPO_ID}::/tmp/wt-cli-agent`
const WT_OTHER = `${REPO_ID}::/tmp/wt-other`

// Use daemon ids, outside serve-/ssh-shaped ownership heuristics.
const CLI_PTY = `${WT_CLI}@@a1b2c3d4`
const OTHER_PTY = `${WT_OTHER}@@e5f6a7b8`
const PTY_ID_BY_WORKTREE: Record<string, string> = { [WT_CLI]: CLI_PTY, [WT_OTHER]: OTHER_PTY }

type RuntimeInternals = {
  ptysById: Map<string, { connected: boolean; runtimeSessionOwned: boolean }>
  mobileSessionTabsByWorktree: Map<string, unknown>
}

function makeRepo() {
  return {
    id: REPO_ID,
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 1
  }
}

function createHarness() {
  let session: WorkspaceSessionState = { ...getDefaultWorkspaceSession() }
  const repo = makeRepo()
  const store = withDurableRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  })
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({
    closeTerminal: vi.fn(),
    closeTerminalTab: vi.fn(),
    revealTerminalSession: vi.fn(async () => null),
    createTerminal: vi.fn(),
    activateWorktree: vi.fn(),
    focusTerminal: vi.fn(),
    terminalDriverChanged: vi.fn()
  } as never)
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockImplementation(async (selector: string) => {
    const worktreeId = selector.replace(/^id:/, '')
    return {
      id: worktreeId,
      path: worktreeId.split('::')[1],
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }
  })

  const persistPtyBinding = (
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ): void => {
    session = {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: [
          ...(session.tabsByWorktree?.[worktreeId] ?? []),
          {
            id: tabId,
            ptyId,
            worktreeId,
            title: 'codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [tabId]: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: ptyId }
        }
      }
    }
  }

  const spawnedTabIdByWorktree = new Map<string, string>()
  const spawn = vi.fn(
    committingSpawn(
      runtime,
      async (args: {
        worktreeId?: string
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }) => {
        const { worktreeId, tabId, leafId } = args
        if (!worktreeId || !tabId || !leafId) {
          throw new Error('pane spawn without a worktree, tab and leaf')
        }
        const ptyId = PTY_ID_BY_WORKTREE[worktreeId]!
        spawnedTabIdByWorktree.set(worktreeId, tabId)
        // Only the production create flag may grant the fixture's persisted ownership.
        if (args.persistHostSessionBinding) {
          persistPtyBinding(worktreeId, tabId, leafId, ptyId)
        }
        return { id: ptyId }
      }
    )
  )
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: vi.fn(() => true),
    stopAndWait: vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, 0)
      return true
    }),
    listProcesses: vi.fn(async () => []),
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)

  const events: RuntimeMobileSessionTabsResult[] = []
  const removed: string[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    events.push(snapshot)
    if ((snapshot as RuntimeMobileSessionTabsRemovedResult).removed) {
      removed.push(snapshot.worktree)
    }
  })

  const createCliTerminal = async (worktreeId: string): Promise<string> => {
    await runtime.createTerminal(`id:${worktreeId}`, { focus: false })
    const tabId = spawnedTabIdByWorktree.get(worktreeId)
    expect(tabId).toBeDefined()
    const pty = (runtime as unknown as RuntimeInternals).ptysById.get(
      PTY_ID_BY_WORKTREE[worktreeId]!
    )
    expect(pty?.connected).toBe(true)
    return tabId!
  }

  /** Unmounted worktrees are omitted; versions must increase to pass client freshness gates. */
  let syncVersion = 0
  const syncRendererGraph = (worktreeIds: readonly string[]): void => {
    syncVersion += 1
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: worktreeIds.map((worktreeId) => ({
        worktree: worktreeId,
        publicationEpoch: 'renderer:incident-epoch',
        snapshotVersion: syncVersion,
        activeGroupId: 'group-1',
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }))
    } as never)
  }

  return {
    runtime,
    events,
    removed,
    createCliTerminal,
    syncRendererGraph,
    snapshotTabIds: (worktreeId: string): string[] =>
      (
        (runtime as unknown as RuntimeInternals).mobileSessionTabsByWorktree.get(worktreeId) as
          | { tabs: { parentTabId?: string }[] }
          | undefined
      )?.tabs.flatMap((tab) => (tab.parentTabId ? [tab.parentTabId] : [])) ?? [],
    hasSnapshot: (worktreeId: string): boolean =>
      (runtime as unknown as RuntimeInternals).mobileSessionTabsByWorktree.has(worktreeId),
    markPtyExited: (ptyId: string): void => {
      const record = (runtime as unknown as RuntimeInternals).ptysById.get(ptyId)!
      record.connected = false
    },
    retirePersistedTabs: (worktreeId: string): void => {
      session = {
        ...session,
        tabsByWorktree: { ...session.tabsByWorktree, [worktreeId]: [] }
      }
    },
    persistedTabIds: (worktreeId: string): string[] =>
      (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id),
    isRuntimeSessionOwned: (ptyId: string): boolean =>
      (runtime as unknown as RuntimeInternals).ptysById.get(ptyId)?.runtimeSessionOwned === true
  }
}

describe('graph sync must not prune a tab whose daemon PTY is live', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a live CLI terminal when the renderer syncs a DIFFERENT worktree', async () => {
    const h = createHarness()
    // CLI publication inherits the renderer-owned epoch already stored for this workspace.
    h.syncRendererGraph([WT_CLI])
    await h.createCliTerminal(WT_CLI)
    expect(h.hasSnapshot(WT_CLI)).toBe(true)

    h.syncRendererGraph([WT_OTHER])
    vi.advanceTimersByTime(300)

    expect(h.hasSnapshot(WT_CLI)).toBe(true)
    expect(h.removed).not.toContain(WT_CLI)
  })

  it('keeps a live CLI terminal when the renderer republishes ITS worktree without it', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)

    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)

    expect(h.snapshotTabIds(WT_CLI)).toContain(cliTabId)
  })

  it('control: still prunes the tab once its PTY has exited', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    await h.createCliTerminal(WT_CLI)
    h.markPtyExited(CLI_PTY)

    h.syncRendererGraph([WT_OTHER])
    vi.advanceTimersByTime(300)

    expect(h.hasSnapshot(WT_CLI)).toBe(false)
  })

  it('control: prunes the CLI terminal once a user close de-persists its tab', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)

    // Keep the PTY connected after de-persist to catch STA-4593 closed-tab resurrection.
    h.retirePersistedTabs(WT_CLI)
    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)

    expect(h.snapshotTabIds(WT_CLI)).not.toContain(cliTabId)
  })

  // A close may race one publication; the following sync must prune the transient stale row.
  it('a close that races the renderer publication still prunes on the next sync', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)

    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)
    expect(h.snapshotTabIds(WT_CLI)).toContain(cliTabId)

    h.retirePersistedTabs(WT_CLI)
    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)

    expect(h.snapshotTabIds(WT_CLI)).not.toContain(cliTabId)
  })

  // Drive real close too: fixture-only de-persist would miss a production route retaining the binding.
  it('a real paired close de-persists the CLI terminal and stops preserving it', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)
    expect(h.persistedTabIds(WT_CLI)).toContain(cliTabId)
    expect(h.isRuntimeSessionOwned(CLI_PTY)).toBe(true)

    await h.runtime.closeMobileSessionTab(`id:${WT_CLI}`, cliTabId, { reason: 'user' })

    expect(h.persistedTabIds(WT_CLI)).not.toContain(cliTabId)
    expect(h.isRuntimeSessionOwned(CLI_PTY)).toBe(false)

    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)
    expect(h.snapshotTabIds(WT_CLI)).not.toContain(cliTabId)
  })

  it('keeps every live CLI terminal when the renderer publishes no worktree at all', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI, WT_OTHER])
    await h.createCliTerminal(WT_CLI)
    await h.createCliTerminal(WT_OTHER)

    h.syncRendererGraph([])
    vi.advanceTimersByTime(300)

    expect(h.hasSnapshot(WT_CLI)).toBe(true)
    expect(h.hasSnapshot(WT_OTHER)).toBe(true)
  })
})
