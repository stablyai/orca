import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-close-continuity'
const WORKTREE_PATH = '/tmp/terminal-close-continuity'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-close-continuity'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-close-continuity'
const INCARNATION_ID = '22222222-2222-4222-8222-222222222222'

function makeSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: INCARNATION_ID
    }
  }
}

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createHarness() {
  let session = makeSession()
  let incarnationId = INCARNATION_ID
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'close-continuity',
    badgeColor: '#000000',
    addedAt: 1
  }
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
    }
  }
  const acknowledged = makeDeferred()
  const closeTerminal = vi.fn()
  const closeTerminalTab = vi.fn(() => acknowledged.promise)
  const kill = vi.fn(() => true)
  const listProcesses = vi.fn(async () => [
    {
      id: PTY_ID,
      incarnationId,
      cwd: WORKTREE_PATH,
      title: 'Fixture shell'
    }
  ])
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
  runtime.setPtyController({
    write: () => true,
    kill,
    listProcesses,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)

  const syncFixtureGraph = () =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 7,
          ptyId: PTY_ID
        }
      ]
    })

  syncFixtureGraph()
  return {
    runtime,
    acknowledged,
    closeTerminal,
    closeTerminalTab,
    kill,
    syncFixtureGraph,
    getSession: () => session,
    retirePersistedTab: () => {
      session = {
        ...session,
        tabsByWorktree: { ...session.tabsByWorktree, [WORKTREE_ID]: [] },
        terminalLayoutsByTabId: {},
        terminalPtyIncarnationsByPaneKey: {}
      }
    },
    replaceIncarnation: (next: string) => {
      incarnationId = next
    }
  }
}

describe('terminal close and handle incarnation continuity', () => {
  it('does not acknowledge final-pane close before durable tab retirement', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    let settled = false
    const closing = harness.runtime.closeTerminal(handle).finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_ID))
    expect(settled).toBe(false)
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)

    harness.retirePersistedTab()
    harness.acknowledged.resolve()
    await expect(closing).resolves.toMatchObject({ handle, tabId: TAB_ID, ptyKilled: true })
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('keeps a handle valid when renderer reload preserves the PTY incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after).toMatchObject({ handle: before.handle, incarnationId: INCARNATION_ID })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('stales the old handle when the same PTY id names a new incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.replaceIncarnation('33333333-3333-4333-8333-333333333333')
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    expect(after.incarnationId).toBe('33333333-3333-4333-8333-333333333333')
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a retained handle after the renderer graph becomes unavailable', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markGraphUnavailable(1)
    harness.runtime.attachWindow(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a renderer handle superseded by a preallocated handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    const preallocated = 'term_preallocated-close-continuity'

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(preallocated)
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })
})
