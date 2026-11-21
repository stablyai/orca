import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

// #24914: renaming an idle leaf-backed terminal must show up in `terminal list`
// even though the pane keeps reporting the title it set before the rename.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-idle-1'

function makeStore(savedTab: boolean) {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  if (savedTab) {
    session.tabsByWorktree[WORKTREE_ID] = [
      {
        id: 'tab-1',
        ptyId: null,
        worktreeId: WORKTREE_ID,
        title: 'probe-worktree',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
  }
  const repo = {
    id: 'repo-1',
    path: '/tmp/probe-worktree',
    displayName: 'probe',
    badgeColor: '#000000',
    addedAt: 0
  }
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [repo]),
    getRepo: vi.fn((id: string) => (id === repo.id ? repo : undefined)),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function syncGraph(
  runtime: OrcaRuntimeService,
  tabTitle: string,
  paneTitle = 'probe-worktree'
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: tabTitle,
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        // The pane's own title from before the rename; an idle pane never replaces it.
        paneTitle,
        title: tabTitle
      }
    ]
  })
}

function makeRuntime(savedTab = false): {
  runtime: OrcaRuntimeService
  renameTerminal: ReturnType<typeof vi.fn>
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only store stub; makeStore covers the reads this suite drives.
  const runtime = new OrcaRuntimeService(makeStore(savedTab) as never)
  const renameTerminal = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only controller stub; only listProcesses is exercised.
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [{ id: PTY_ID, cwd: '/tmp/probe-worktree' }])
  } as never)
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal,
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  syncGraph(runtime, 'probe-worktree')
  return { runtime, renameTerminal }
}

describe('terminal list title after renaming an idle terminal', () => {
  it('reports the new title right after the rename', async () => {
    const { runtime, renameTerminal } = makeRuntime()
    const before = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(before.terminals[0].title).toBe('probe-worktree')

    await runtime.renameTerminal(before.terminals[0].handle, 'My Label')

    expect(renameTerminal).toHaveBeenCalledWith('tab-1', 'My Label')
    const after = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(after.terminals[0].title).toBe('My Label')
  })

  it('shows the pane title once the tab name is cleared in the UI', async () => {
    const { runtime } = makeRuntime(true)
    const before = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    await runtime.renameTerminal(before.terminals[0].handle, 'My Label')

    const after = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(after.terminals[0].title).toBe('probe-worktree')
  })

  it('keeps the new title when the pane reports a new title after the rename', async () => {
    const { runtime } = makeRuntime()
    const before = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    await runtime.renameTerminal(before.terminals[0].handle, 'My Label')
    syncGraph(runtime, 'My Label', 'codex: working')

    const after = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(after.terminals[0].title).toBe('My Label')
  })
})
