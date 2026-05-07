/**
 * Integration test for the mobile-fit override flow.
 * Tests the full lifecycle: mobile-fit → restore → verify PTY resized.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

vi.mock('../hooks', () => ({
  createSetupRunnerScript: vi.fn(),
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})

vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null),
    getGitUsername: vi.fn().mockReturnValue('')
  }
})

const store = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [store.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

describe('fit override integration', () => {
  it('full lifecycle: fit → getSize → restore → verify PTY dims', async () => {
    const runtime = new OrcaRuntimeService(store)
    const currentSize = { cols: 150, rows: 40 }
    const resizes: { ptyId: string; cols: number; rows: number }[] = []
    const notifications: { ptyId: string; mode: string; cols: number; rows: number }[] = []

    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: (ptyId, cols, rows) => {
        currentSize.cols = cols
        currentSize.rows = rows
        resizes.push({ ptyId, cols, rows })
        return true
      },
      getSize: () => ({ ...currentSize })
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: (ptyId, mode, cols, rows) => {
        notifications.push({ ptyId, mode, cols, rows })
      },
      terminalDriverChanged: vi.fn()
    })

    // Simulate a synced leaf (mounted desktop pane)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    console.log('=== Step 1: Initial state ===')
    console.log('PTY size:', currentSize)
    expect(currentSize).toEqual({ cols: 150, rows: 40 })

    console.log('\n=== Step 2: Mobile fit to 45x20 ===')
    const fitResult = await runtime.resizeForClient('pty-1', 'mobile-fit', 'client-phone', 45, 20)
    console.log('Fit result:', fitResult)
    console.log('PTY size after fit:', currentSize)
    console.log('Override:', runtime.getTerminalFitOverride('pty-1'))
    expect(currentSize).toEqual({ cols: 45, rows: 20 })
    expect(fitResult.previousCols).toBe(150)
    expect(fitResult.previousRows).toBe(40)

    console.log('\n=== Step 3: Desktop Restore (via IPC handler path) ===')
    // Simulate what runtime:restoreTerminalFit IPC handler does
    const override = runtime.getTerminalFitOverride('pty-1')
    expect(override).not.toBeNull()
    const restoreResult = await runtime.resizeForClient('pty-1', 'restore', override!.clientId)
    console.log('Restore result:', restoreResult)
    console.log('PTY size after restore:', currentSize)
    console.log('Override after restore:', runtime.getTerminalFitOverride('pty-1'))
    expect(currentSize).toEqual({ cols: 150, rows: 40 })
    expect(restoreResult.mode).toBe('desktop-fit')

    console.log('\n=== Step 4: Verify all resizes ===')
    console.log('All resize calls:', resizes)
    expect(resizes).toEqual([
      { ptyId: 'pty-1', cols: 45, rows: 20 },
      { ptyId: 'pty-1', cols: 150, rows: 40 }
    ])

    console.log('\n=== Step 5: Verify notifications ===')
    console.log('All notifications:', notifications)
    expect(notifications).toEqual([
      { ptyId: 'pty-1', mode: 'mobile-fit', cols: 45, rows: 20 },
      { ptyId: 'pty-1', mode: 'desktop-fit', cols: 150, rows: 40 }
    ])

    console.log('\n=== Step 6: Mobile restore via RPC path ===')
    // Re-fit, then restore via the mobile RPC handler path
    await runtime.resizeForClient('pty-1', 'mobile-fit', 'client-phone', 45, 20)
    expect(currentSize).toEqual({ cols: 45, rows: 20 })

    // This is what terminal.resizeForClient RPC handler does
    const mobileRestore = await runtime.resizeForClient('pty-1', 'restore', 'client-phone')
    console.log('Mobile restore result:', mobileRestore)
    console.log('PTY size after mobile restore:', currentSize)
    expect(currentSize).toEqual({ cols: 150, rows: 40 })
  })

  it('restore resizes PTY even with mounted leaf (the bug fix)', async () => {
    const runtime = new OrcaRuntimeService(store)
    let ptySize = { cols: 120, rows: 35 }
    const resizes: string[] = []

    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: (ptyId, cols, rows) => {
        ptySize = { cols, rows }
        resizes.push(`${ptyId}:${cols}x${rows}`)
        return true
      },
      getSize: () => ({ ...ptySize })
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    // Synced leaf = mounted desktop pane
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    // Mobile fit
    await runtime.resizeForClient('pty-1', 'mobile-fit', 'phone-a', 42, 18)
    expect(ptySize).toEqual({ cols: 42, rows: 18 })

    // Restore — THIS is the critical assertion.
    // Before the fix, mounted leaves skipped the PTY resize.
    await runtime.resizeForClient('pty-1', 'restore', 'phone-a')
    expect(ptySize).toEqual({ cols: 120, rows: 35 })
    expect(resizes).toEqual(['pty-1:42x18', 'pty-1:120x35'])
  })

  it('disconnect auto-restore also resizes PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    let ptySize = { cols: 100, rows: 30 }

    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: (_ptyId, cols, rows) => {
        ptySize = { cols, rows }
        return true
      },
      getSize: () => ({ ...ptySize })
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    await runtime.resizeForClient('pty-1', 'mobile-fit', 'phone-disconnect', 45, 20)
    expect(ptySize).toEqual({ cols: 45, rows: 20 })

    // Simulate WS disconnect
    runtime.onClientDisconnected('phone-disconnect')
    // onClientDisconnected enqueues fire-and-forget; flush microtasks
    await new Promise((r) => setTimeout(r, 0))
    expect(ptySize).toEqual({ cols: 100, rows: 30 })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
  })
})
