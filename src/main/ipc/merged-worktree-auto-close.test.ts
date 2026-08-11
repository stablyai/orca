import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { GlobalSettings, Repo } from '../../shared/types'
import type { MergedWorktreeAutoCloseDecision } from '../../shared/merged-worktree-auto-close'
import {
  MERGED_WORKTREE_AUTO_CLOSE_REPO_COOLDOWN_MS,
  autoCloseMergedWorktreesForRepo,
  scheduleMergedWorktreeAutoCloseForRepo,
  _resetMergedWorktreeAutoCloseStateForTests,
  type MergedWorktreeAutoCloseRuntime
} from './merged-worktree-auto-close'

const NOW = 1_800_000_000_000

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}

const CLOSE_DECISION: MergedWorktreeAutoCloseDecision = {
  worktreeId: 'repo-1::/workspaces/feature',
  repoId: 'repo-1',
  path: '/workspaces/feature',
  branch: 'feature',
  action: 'close'
}

const KEEP_DECISION: MergedWorktreeAutoCloseDecision = {
  worktreeId: 'repo-1::/workspaces/wip',
  repoId: 'repo-1',
  path: '/workspaces/wip',
  branch: 'wip',
  action: 'skip',
  reason: 'dirty-files'
}

function createStore(autoCloseMergedWorktrees: boolean): Store {
  return {
    getSettings: () => ({ autoCloseMergedWorktrees }) as GlobalSettings
  } as unknown as Store
}

let removeManagedWorktree: ReturnType<typeof vi.fn>
let runtime: MergedWorktreeAutoCloseRuntime

function scanReturning(decisions: MergedWorktreeAutoCloseDecision[]) {
  return vi.fn().mockResolvedValue(decisions)
}

beforeEach(() => {
  _resetMergedWorktreeAutoCloseStateForTests()
  removeManagedWorktree = vi.fn().mockResolvedValue({})
  runtime = { removeManagedWorktree } as unknown as MergedWorktreeAutoCloseRuntime
})

describe('autoCloseMergedWorktreesForRepo', () => {
  it('removes only the workspaces decided closable, and never with force', async () => {
    const result = await autoCloseMergedWorktreesForRepo(createStore(true), runtime, REPO, {
      now: NOW,
      scan: scanReturning([CLOSE_DECISION, KEEP_DECISION])
    })

    expect(removeManagedWorktree).toHaveBeenCalledTimes(1)
    expect(removeManagedWorktree).toHaveBeenCalledWith(
      'id:repo-1::/workspaces/feature',
      false,
      false,
      false
    )
    expect(result.closed).toEqual(['repo-1::/workspaces/feature'])
    expect(result.failed).toEqual([])
  })

  it('reports a removal that Git refused instead of throwing', async () => {
    removeManagedWorktree.mockRejectedValue(
      new Error('Worktree has uncommitted or untracked changes.')
    )

    const result = await autoCloseMergedWorktreesForRepo(createStore(true), runtime, REPO, {
      now: NOW,
      scan: scanReturning([CLOSE_DECISION])
    })

    expect(result.closed).toEqual([])
    expect(result.failed).toEqual([
      {
        worktreeId: 'repo-1::/workspaces/feature',
        error: 'Worktree has uncommitted or untracked changes.'
      }
    ])
  })
})

describe('scheduleMergedWorktreeAutoCloseForRepo', () => {
  it('does nothing while the setting is off', async () => {
    const scan = scanReturning([CLOSE_DECISION])

    await expect(
      scheduleMergedWorktreeAutoCloseForRepo(createStore(false), runtime, REPO, { now: NOW, scan })
    ).resolves.toBeNull()
    expect(scan).not.toHaveBeenCalled()
    expect(removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('runs once per cooldown window', async () => {
    const store = createStore(true)
    const scan = scanReturning([])

    await scheduleMergedWorktreeAutoCloseForRepo(store, runtime, REPO, { now: NOW, scan })
    await scheduleMergedWorktreeAutoCloseForRepo(store, runtime, REPO, {
      now: NOW + MERGED_WORKTREE_AUTO_CLOSE_REPO_COOLDOWN_MS - 1,
      scan
    })
    expect(scan).toHaveBeenCalledTimes(1)

    await scheduleMergedWorktreeAutoCloseForRepo(store, runtime, REPO, {
      now: NOW + MERGED_WORKTREE_AUTO_CLOSE_REPO_COOLDOWN_MS,
      scan
    })
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('resolves null instead of rejecting when the sweep fails', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('scan exploded'))

    await expect(
      scheduleMergedWorktreeAutoCloseForRepo(createStore(true), runtime, REPO, { now: NOW, scan })
    ).resolves.toBeNull()
  })
})
