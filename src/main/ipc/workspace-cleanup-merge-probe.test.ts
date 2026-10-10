import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'

const {
  gitExecFileAsyncMock,
  branchHasNoUnmergedChangesOnAnyTargetMock,
  getBranchCleanupTargetRefsMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  branchHasNoUnmergedChangesOnAnyTargetMock: vi.fn(),
  getBranchCleanupTargetRefsMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/git-capability-state', () => ({
  withLocalGitCapabilityCacheForExecution: (_target: unknown, run: (cache: unknown) => unknown) =>
    run({})
}))

vi.mock('../../shared/git-branch-cleanup', () => ({
  branchHasNoUnmergedChangesOnAnyTarget: branchHasNoUnmergedChangesOnAnyTargetMock,
  getBranchCleanupTargetRefs: getBranchCleanupTargetRefsMock
}))

import { readWorkspaceCleanupMergeVerdict } from './workspace-cleanup-merge-probe'

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}

function buildWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo-feature',
    repoId: 'repo-1',
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: '/repo-feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

describe('workspace cleanup merge probe', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    getBranchCleanupTargetRefsMock.mockReset().mockResolvedValue(['refs/remotes/origin/main'])
    branchHasNoUnmergedChangesOnAnyTargetMock.mockReset().mockResolvedValue(true)
  })

  it('compares the branch from the repository, never from the worktree that holds it', async () => {
    await readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO)

    // Why: inside the worktree, HEAD *is* the branch, so every branch would
    // merge into itself cleanly and the scan would offer live work for deletion.
    const [runGit] = branchHasNoUnmergedChangesOnAnyTargetMock.mock.calls[0]
    await runGit(['rev-parse', 'HEAD'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('passes the short branch name to the merge proof', async () => {
    await readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO)

    expect(branchHasNoUnmergedChangesOnAnyTargetMock).toHaveBeenCalledWith(
      expect.any(Function),
      'feature',
      ['refs/remotes/origin/main'],
      expect.anything()
    )
  })

  it('reports the merge proof verdict', async () => {
    branchHasNoUnmergedChangesOnAnyTargetMock.mockResolvedValue(false)

    await expect(readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO)).resolves.toBe(false)
  })

  it('forwards stdin so the squash patch-id comparison can run', async () => {
    await readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO)

    const [runGit] = branchHasNoUnmergedChangesOnAnyTargetMock.mock.calls[0]
    await runGit(['patch-id', '--stable'], { stdin: 'diff --git a b' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['patch-id', '--stable'],
      expect.objectContaining({ stdin: 'diff --git a b' })
    )
  })

  it('routes through the project WSL distro', async () => {
    await readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO, { wslDistro: 'Ubuntu' })

    const [runGit] = branchHasNoUnmergedChangesOnAnyTargetMock.mock.calls[0]
    await runGit(['rev-parse', 'HEAD'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })

  it('returns null for an SSH repo instead of guessing', async () => {
    const verdict = await readWorkspaceCleanupMergeVerdict(buildWorktree(), {
      ...REPO,
      connectionId: 'ssh-1'
    })

    expect(verdict).toBeNull()
    expect(branchHasNoUnmergedChangesOnAnyTargetMock).not.toHaveBeenCalled()
  })

  it('returns null for a runtime-owned repo, which local Git cannot judge', async () => {
    // Why: no connectionId, yet the workspace lives on another host. Running the
    // proof here would judge whatever sits at that local path and could drop a
    // real unpushed-commits blocker.
    const verdict = await readWorkspaceCleanupMergeVerdict(buildWorktree(), {
      ...REPO,
      executionHostId: 'runtime:env-1'
    })

    expect(verdict).toBeNull()
    expect(branchHasNoUnmergedChangesOnAnyTargetMock).not.toHaveBeenCalled()
  })

  it('returns null when the workspace itself is owned by another host', async () => {
    const verdict = await readWorkspaceCleanupMergeVerdict(
      buildWorktree({ hostId: 'runtime:env-1' }),
      REPO
    )

    expect(verdict).toBeNull()
    expect(branchHasNoUnmergedChangesOnAnyTargetMock).not.toHaveBeenCalled()
  })

  it('still runs when both repo and workspace are explicitly local', async () => {
    const verdict = await readWorkspaceCleanupMergeVerdict(buildWorktree({ hostId: 'local' }), {
      ...REPO,
      executionHostId: 'local'
    })

    expect(verdict).toBe(true)
  })

  it('returns null for a detached HEAD', async () => {
    const verdict = await readWorkspaceCleanupMergeVerdict(buildWorktree({ branch: 'HEAD' }), REPO)

    expect(verdict).toBeNull()
    expect(branchHasNoUnmergedChangesOnAnyTargetMock).not.toHaveBeenCalled()
  })

  it('returns null for a branch name Git would read as an option', async () => {
    const verdict = await readWorkspaceCleanupMergeVerdict(
      buildWorktree({ branch: 'refs/heads/--upload-pack=touch' }),
      REPO
    )

    expect(verdict).toBeNull()
    expect(branchHasNoUnmergedChangesOnAnyTargetMock).not.toHaveBeenCalled()
  })

  it('returns null when no comparison target resolves', async () => {
    getBranchCleanupTargetRefsMock.mockResolvedValue([])

    await expect(readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO)).resolves.toBeNull()
    expect(branchHasNoUnmergedChangesOnAnyTargetMock).not.toHaveBeenCalled()
  })

  it('returns null when the proof throws', async () => {
    branchHasNoUnmergedChangesOnAnyTargetMock.mockRejectedValue(new Error('git exploded'))

    await expect(readWorkspaceCleanupMergeVerdict(buildWorktree(), REPO)).resolves.toBeNull()
  })
})
