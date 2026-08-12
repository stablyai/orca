import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { GlobalSettings, Repo } from '../../shared/types'
import type { MergedWorktreeAutoCloseDecision } from '../../shared/merged-worktree-auto-close'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
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
      false,
      LOCAL_EXECUTION_HOST_ID
    )
    expect(result.closed).toEqual(['repo-1::/workspaces/feature'])
    expect(result.failed).toEqual([])
  })

  it('never scans or removes for a repo another execution host owns', async () => {
    // Why: `id:repo-1::/workspaces/feature` names a workspace on every host that
    // has this repo, so an unfenced sweep can tear down the wrong one.
    const scan = scanReturning([CLOSE_DECISION])

    const result = await autoCloseMergedWorktreesForRepo(
      createStore(true),
      runtime,
      { ...REPO, executionHostId: toRuntimeExecutionHostId('env-1') },
      { now: NOW, scan }
    )

    expect(scan).not.toHaveBeenCalled()
    expect(removeManagedWorktree).not.toHaveBeenCalled()
    expect(result).toEqual({ closed: [], failed: [], decisions: [] })
  })

  it('reports every workspace it swept, including the ones it kept', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await autoCloseMergedWorktreesForRepo(createStore(true), runtime, REPO, {
      now: NOW,
      scan: scanReturning([CLOSE_DECISION, KEEP_DECISION])
    })

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('[worktree-auto-close] swept "Repo" (repo-1)')
    )
    const line = info.mock.calls[0]?.[0] as string
    expect(line).toContain('feature=closed')
    expect(line).toContain('wip=skip:dirty-files')
    info.mockRestore()
  })

  it('reports the error when a removal was refused', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    removeManagedWorktree.mockRejectedValue(new Error('Worktree is busy.'))

    await autoCloseMergedWorktreesForRepo(createStore(true), runtime, REPO, {
      now: NOW,
      scan: scanReturning([CLOSE_DECISION])
    })

    expect(info.mock.calls[0]?.[0]).toContain('feature=close-failed(Worktree is busy.)')
    info.mockRestore()
  })

  it('keeps the sweep line on one physical line when the refusal message spans several', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    removeManagedWorktree.mockRejectedValue(
      new Error(
        "Command failed: git worktree remove /tmp/x\nfatal: '/tmp/x' contains modified or untracked files, use --force to delete it\n"
      )
    )

    await autoCloseMergedWorktreesForRepo(createStore(true), runtime, REPO, {
      now: NOW,
      scan: scanReturning([CLOSE_DECISION])
    })

    const line = info.mock.calls[0]?.[0] as string
    expect(line).toContain('feature=close-failed(Command failed: git worktree remove /tmp/x)')
    expect(line.split('\n')).toHaveLength(1)
    info.mockRestore()
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

  it('coalesces a second request onto the sweep already running', async () => {
    // Why: the cooldown alone does not cover a sweep that is still running, and a
    // second sweep would fan out a duplicate Git probe per branch.
    const store = createStore(true)
    let release: (decisions: MergedWorktreeAutoCloseDecision[]) => void = () => {}
    const scan = vi.fn().mockReturnValue(
      new Promise<MergedWorktreeAutoCloseDecision[]>((resolve) => {
        release = resolve
      })
    )

    const first = scheduleMergedWorktreeAutoCloseForRepo(store, runtime, REPO, { now: NOW, scan })
    // Why past the cooldown: inside it the cooldown would coalesce this on its own,
    // and the test would pass with no in-flight guard at all.
    const second = scheduleMergedWorktreeAutoCloseForRepo(store, runtime, REPO, {
      now: NOW + MERGED_WORKTREE_AUTO_CLOSE_REPO_COOLDOWN_MS,
      scan
    })
    release([])

    expect(await second).toEqual(await first)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('resolves null instead of rejecting when the sweep fails', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('scan exploded'))

    await expect(
      scheduleMergedWorktreeAutoCloseForRepo(createStore(true), runtime, REPO, { now: NOW, scan })
    ).resolves.toBeNull()
  })
})
