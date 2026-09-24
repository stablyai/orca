import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  UNSTOPPED_PTY_DETAIL_SEPARATOR,
  UNSTOPPED_PTY_REMOVAL_PREFIX,
  STILL_LIVE_DETAIL_PREFIX
} from '../shared/worktree/removal'
import {
  collectWorktreeSessionTree,
  errorIfOrphanDirectoryRemains,
  runLocalFinishedWorktreeForceCleanup,
  rewriteUnstoppedPtyErrorForFinishedWorktree,
  settleOrphanedLocalWorktreeDirectory,
  WORKTREE_DIRECTORY_KEPT_METADATA_MESSAGE
} from './worktree-finished-force-cleanup'

const liveError = new Error(
  `${UNSTOPPED_PTY_REMOVAL_PREFIX} repo::/wt${UNSTOPPED_PTY_DETAIL_SEPARATOR}${STILL_LIVE_DETAIL_PREFIX} repo::/wt@@term`
)

describe('finished worktree force cleanup', () => {
  it('SIGTERM-then-SIGKILL is requested only for an eligible explicit force cleanup', async () => {
    const killTree = vi.fn(async () => ({ livePids: [] as number[] }))
    const plan = await runLocalFinishedWorktreeForceCleanup({
      allowUnverifiedPtyStop: true,
      worktreeId: 'repo::/wt',
      worktreePath: '/wt',
      branch: 'refs/heads/auto',
      repoPath: '/repo',
      hasAutomationProvenance: true,
      listSessions: async () => [{ id: 'repo::/wt@@term', rootProcessId: 4242, paneBound: false }],
      listRegistrations: () => [],
      killTree
    })

    expect(killTree).toHaveBeenCalledWith([4242])
    expect(plan).toEqual({ qualifies: true, rootPids: [4242], livePids: [] })
  })

  it('does not kill a user worktree that still has a UI-visible session', async () => {
    const killTree = vi.fn(async () => ({ livePids: [] as number[] }))
    const plan = await runLocalFinishedWorktreeForceCleanup({
      allowUnverifiedPtyStop: true,
      worktreeId: 'repo::/wt',
      worktreePath: '/wt',
      branch: 'refs/heads/feature',
      repoPath: '/repo',
      hasAutomationProvenance: false,
      workspaceStatus: 'completed',
      listSessions: async () => [{ id: 'repo::/wt@@term', rootProcessId: 50, paneBound: true }],
      listRegistrations: () => [],
      killTree
    })

    expect(killTree).not.toHaveBeenCalled()
    expect(plan.qualifies).toBe(false)
  })

  it('rewrites a proven-live stop into the pid blocker for an eligible worktree', () => {
    const rewritten = rewriteUnstoppedPtyErrorForFinishedWorktree(liveError, {
      qualifies: true,
      rootPids: [4242],
      livePids: []
    })
    expect(rewritten.message).toBe('cannot delete because PID 4242 still running in this worktree')
    expect(rewritten.message).not.toContain('selector_not_found')
  })

  it('leaves the fail-closed error unchanged for a user worktree', () => {
    const plan = { qualifies: false, rootPids: [4242], livePids: [] as number[] }
    expect(rewriteUnstoppedPtyErrorForFinishedWorktree(liveError, plan)).toBe(liveError)
  })
})

describe('orphaned directory removal keeps metadata when the folder remains', () => {
  it('reports still-present when the directory cannot be proved gone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-orphan-keep-'))
    const worktreePath = join(parent, 'feature')
    const repoPath = join(parent, 'repo')
    await mkdir(worktreePath)
    await mkdir(repoPath)
    await writeFile(join(worktreePath, 'keep.txt'), 'still here')
    try {
      const settlement = await settleOrphanedLocalWorktreeDirectory({
        worktreePath,
        repoPath,
        options: {},
        closeWatchers: async () => undefined
      })
      expect(settlement).toBe('still-present')
      const error = errorIfOrphanDirectoryRemains(settlement, worktreePath, {
        qualifies: false,
        rootPids: [],
        livePids: []
      })
      expect(error?.message).toContain(WORKTREE_DIRECTORY_KEPT_METADATA_MESSAGE)
      expect(error?.message).not.toContain('selector_not_found')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('names the surviving pid when force cleanup could not remove the directory', () => {
    const error = errorIfOrphanDirectoryRemains('still-present', '/wt', {
      qualifies: true,
      rootPids: [4242],
      livePids: [4242]
    })
    expect(error?.message).toBe('cannot delete because PID 4242 still running in this worktree')
    expect(error?.message).not.toContain('selector_not_found')
  })

  it('drops nothing to report once the directory is gone', () => {
    expect(
      errorIfOrphanDirectoryRemains('gone', '/wt', {
        qualifies: true,
        rootPids: [1],
        livePids: []
      })
    ).toBeNull()
  })
})

describe('collectWorktreeSessionTree', () => {
  it('ignores sessions that belong to another worktree', () => {
    const tree = collectWorktreeSessionTree({
      worktreeId: 'repo::/wt',
      worktreePath: '/wt',
      registrations: [{ worktreeId: 'repo::/other', pid: 9 }],
      sessions: [{ id: 'other@@1', cwd: '/other', rootProcessId: 8, paneBound: true }]
    })
    expect(tree).toEqual({ rootPids: [], hasLiveUiVisibleSession: false })
  })
})
