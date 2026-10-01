/**
 * Integration test for the mobile-fit override flow.
 * Tests the full lifecycle: mobile-fit → restore → verify PTY resized.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
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
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([]),
  listWorktreesFromMembershipStrict: vi.fn().mockResolvedValue([])
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../worktree-runner-script', () => ({ createSetupRunnerScript: vi.fn() }))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})

vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})

vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
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
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

describe('fit override integration', () => {
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
})
