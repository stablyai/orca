/**
 * shouldPreserveHeadlessMobileSessionTab excludes the daemon ptyId form
 * <worktreeId>@@<uuid> from its runtime-owned checks, so a host-created terminal
 * survives renderer omission only through the binding createTerminal persists;
 * a renderer de-persist (a user close) releases it again.
 *
 * These assert only on a PTY the runtime records as connected or exited —
 * never on "unverifiable".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const REPO_ID = 'repo-1'
const WT_CLI = `${REPO_ID}::/tmp/wt-cli-agent`
const WT_OTHER = `${REPO_ID}::/tmp/wt-other`

// Daemon session id form: <worktreeId>@@<shortUuid>. NOT serve-/ssh-shaped.
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
  // Starts empty: only the create path may put this terminal in the session.
  let session: WorkspaceSessionState = { ...getDefaultWorkspaceSession() }
  const repo = makeRepo()
  const store = {
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
  }
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

  /** Stands in for LoadingStore.persistPtyBinding: the minimal tab + layout the
   *  store writes when a spawn carries persistHostSessionBinding. */
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
    async (args: {
      worktreeId: string
      tabId: string
      leafId: string
      persistHostSessionBinding?: boolean
    }) => {
      const ptyId = PTY_ID_BY_WORKTREE[args.worktreeId]!
      spawnedTabIdByWorktree.set(args.worktreeId, args.tabId)
      // Why: only the host binding contract decides this — the test must not
      // hand the runtime an ownership signal the create path did not produce.
      if (args.persistHostSessionBinding) {
        persistPtyBinding(args.worktreeId, args.tabId, args.leafId, ptyId)
      }
      return { id: ptyId }
    }
  )
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: vi.fn(() => true),
    stopAndWait: vi.fn(async () => true),
    listProcesses: vi.fn(async () => []),
    getForegroundProcess: async () => null
  } as never)
  // The host runs the full desktop app: a window IS attached.
  runtime.attachWindow(1)

  const events: RuntimeMobileSessionTabsResult[] = []
  const removed: string[] = []
  // Removals reach clients as an ordinary snapshot frame carrying removed:true
  // (notifyMobileSessionTabsRemoved) — there is no separate listener.
  runtime.onMobileSessionTabsChanged((snapshot) => {
    events.push(snapshot)
    if ((snapshot as RuntimeMobileSessionTabsRemovedResult).removed) {
      removed.push(snapshot.worktree)
    }
  })

  /** An `orca terminal create` on this host, through the real create path. */
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

  /** A renderer graph sync that mentions ONLY `worktreeIds` — i.e. the panes the
   *  renderer currently has mounted. Any orca-cli dispatch triggers one.
   *  `version` must climb, or web clients drop the frame as stale. */
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
    /** The user closed the tab: the renderer de-persists it from the session. */
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
    // The host app is running and the renderer already owns this workspace, so
    // its snapshot carries the RENDERER's publication epoch. The CLI terminal
    // published next inherits that epoch (publishPtyBackedMobileSessionTerminal).
    h.syncRendererGraph([WT_CLI])
    await h.createCliTerminal(WT_CLI)
    expect(h.hasSnapshot(WT_CLI)).toBe(true)

    // An orca-cli dispatch in another worktree drives a renderer graph sync that
    // does not mention WT_CLI at all.
    h.syncRendererGraph([WT_OTHER])
    vi.advanceTimersByTime(300)

    // RED on main: the prune loop deletes WT_CLI and emits a removal frame, so
    // the paired client clears the strip while the agent keeps running.
    expect(h.hasSnapshot(WT_CLI)).toBe(true)
    expect(h.removed).not.toContain(WT_CLI)
  })

  it('keeps a live CLI terminal when the renderer republishes ITS worktree without it', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)

    // The renderer owns no pane for this terminal, so its publication for the
    // same worktree carries zero tabs.
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

    // A dead terminal must not be preserved — that is the STA-4593 resurrection
    // invariant, and the reason id-shape preservation was narrowed originally.
    expect(h.hasSnapshot(WT_CLI)).toBe(false)
  })

  it('control: prunes the CLI terminal once a user close de-persists its tab', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)

    // A user close is what removes the tab from the persisted session. The PTY
    // deliberately stays connected: STA-4593's host is one where PTYs outlive
    // their tabs, and that is exactly when resurrection used to happen.
    h.retirePersistedTabs(WT_CLI)
    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)

    expect(h.snapshotTabIds(WT_CLI)).not.toContain(cliTabId)
  })

  // N2: the renderer can republish before its de-persist reaches the host
  // session, so a just-closed tab can linger for one frame. Confirming that
  // window is TRANSIENT — the next publication prunes it — not a resurrection.
  it('a close that races the renderer publication still prunes on the next sync', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)

    // Publication lands first, while the session still lists the tab.
    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)
    expect(h.snapshotTabIds(WT_CLI)).toContain(cliTabId)

    // The de-persist lands afterwards; the very next sync releases ownership.
    h.retirePersistedTabs(WT_CLI)
    h.syncRendererGraph([WT_CLI])
    vi.advanceTimersByTime(300)

    expect(h.snapshotTabIds(WT_CLI)).not.toContain(cliTabId)
  })

  // The safety argument for always persisting rests on a real close actually
  // DROPPING that persisted binding. Every other control here hands the
  // de-persist to the harness, which would pass even if no close route did it.
  // This one drives the real close and lets the production code decide.
  it('a real paired close de-persists the CLI terminal and stops preserving it', async () => {
    const h = createHarness()
    h.syncRendererGraph([WT_CLI])
    const cliTabId = await h.createCliTerminal(WT_CLI)
    expect(h.persistedTabIds(WT_CLI)).toContain(cliTabId)
    expect(h.isRuntimeSessionOwned(CLI_PTY)).toBe(true)

    await h.runtime.closeMobileSessionTab(`id:${WT_CLI}`, cliTabId, { reason: 'user' })

    // The close must drop the persisted binding, or the tab is preserved forever
    // and STA-4593's closed-tab resurrection returns through the CLI path.
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
