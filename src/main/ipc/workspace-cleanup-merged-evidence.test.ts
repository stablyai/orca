import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'

const { getStatusMock, gitExecFileAsyncMock, readWorkspaceCleanupMergeVerdictMock } = vi.hoisted(
  () => ({
    getStatusMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    readWorkspaceCleanupMergeVerdictMock: vi.fn()
  })
)

vi.mock('../git/status', () => ({ getStatus: getStatusMock }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('./workspace-cleanup-merge-probe', () => ({
  readWorkspaceCleanupMergeVerdict: readWorkspaceCleanupMergeVerdictMock
}))
vi.mock('../git/worktree-shared-directories', () => ({
  getWorktreeSharedLinkPaths: () => []
}))

import { readWorkspaceCleanupGitEvidence } from './workspace-cleanup-git-evidence'

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}

const WORKTREE = {
  id: 'repo-1::/repo-feature',
  path: '/repo-feature',
  branch: 'refs/heads/feature',
  head: 'abc123'
} as Worktree

/** The shape a squash merge leaves behind: clean tree, PR branch deleted on the
 *  remote so there is no upstream, and local commits that exist nowhere else. */
function buildSquashMergedStatus(): GitStatusResult {
  return {
    entries: [],
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  } as unknown as GitStatusResult
}

describe('workspace cleanup git evidence merge handling', () => {
  beforeEach(() => {
    getStatusMock.mockReset().mockResolvedValue(buildSquashMergedStatus())
    // Why: HEAD carries commits that reach no remote — the count that used to
    // brand every squash-merged workspace as unpushed.
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '3\n', stderr: '' })
    readWorkspaceCleanupMergeVerdictMock.mockReset().mockResolvedValue(true)
  })

  it('stops calling a squash-merged workspace unpushed', async () => {
    const evidence = await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null)

    expect(evidence.merged).toBe(true)
    expect(evidence.blockers).not.toContain('unpushed-commits')
    expect(evidence.blockers).not.toContain('unknown-base')
  })

  it('skips the unpushed count entirely once the merge is proven', async () => {
    await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps blocking an unmerged workspace whose commits reach no remote', async () => {
    readWorkspaceCleanupMergeVerdictMock.mockResolvedValue(false)

    const evidence = await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null)

    expect(evidence.merged).toBe(false)
    expect(evidence.blockers).toContain('unpushed-commits')
  })

  it('keeps blocking an unmerged workspace that is ahead of its upstream', async () => {
    getStatusMock.mockResolvedValue({
      entries: [],
      upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
    } as unknown as GitStatusResult)
    readWorkspaceCleanupMergeVerdictMock.mockResolvedValue(false)

    const evidence = await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null)

    expect(evidence.blockers).toContain('unpushed-commits')
  })

  it('still blocks uncommitted work in a merged workspace', async () => {
    getStatusMock.mockResolvedValue({
      entries: [{ path: 'a.ts' }],
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    } as unknown as GitStatusResult)

    const evidence = await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null)

    expect(evidence.blockers).toContain('dirty-files')
    // Why: probing a dirty workspace cannot change the outcome, so it is skipped.
    expect(evidence.merged).toBeNull()
    expect(readWorkspaceCleanupMergeVerdictMock).not.toHaveBeenCalled()
  })

  it('falls back to the pre-existing blockers when the verdict is unknown', async () => {
    readWorkspaceCleanupMergeVerdictMock.mockResolvedValue(null)

    const evidence = await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null)

    expect(evidence.merged).toBeNull()
    expect(evidence.blockers).toContain('unpushed-commits')
  })

  it('forwards the project WSL distro to the probe', async () => {
    await readWorkspaceCleanupGitEvidence(WORKTREE, REPO, null, undefined, { wslDistro: 'Ubuntu' })

    expect(readWorkspaceCleanupMergeVerdictMock).toHaveBeenCalledWith(
      WORKTREE,
      REPO,
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })
})
