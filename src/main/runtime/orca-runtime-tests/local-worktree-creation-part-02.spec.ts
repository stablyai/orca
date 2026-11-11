import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { addWorktree } from '../../git/worktrees/creation/worktree-add'
import {
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getPRForBranchMock
} from '../orca-runtime-test-mocks/setup.spec'
import { getBranchConflictKindStrict } from '../../git/repo-branch-conflict'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { store } from './orca-runtime-test-fixtures.spec'
import { getLocalWorktreeScanGeneration } from '../../workspaces/catalog/local-worktree-scan-generation'

describe('OrcaRuntimeService', () => {
  it('bumps the scan generation before the first step after git worktree add', async () => {
    // Bump generation before post-add awaits so clients can reject earlier listings that omit the new worktree.
    const witness: { duringAdd?: number; afterAdd?: number } = {}
    // Generated-name retirement is the first await after add, exposing the generation race.
    const addRetiredWorktreeName = vi.fn(() => {
      if (witness.duringAdd !== undefined && witness.afterAdd === undefined) {
        witness.afterAdd = getLocalWorktreeScanGeneration('repo-1')
      }
    })
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    const createdWorktree = {
      path: '/tmp/workspaces/nautilus',
      head: 'abc123',
      branch: 'refs/heads/nautilus',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockImplementationOnce(async () => {
      witness.duringAdd = getLocalWorktreeScanGeneration('repo-1')
      return {}
    })
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })

    expect(addRetiredWorktreeName).toHaveBeenCalledWith('repo-1', 'nautilus')
    expect(witness.afterAdd).toBeGreaterThan(witness.duringAdd ?? Infinity)
  })

  it('refuses an exact-name create even when a selected PR matches the remote branch', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/fix-title')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/fix-title')
    vi.mocked(addWorktree).mockClear()
    vi.mocked(getBranchConflictKindStrict).mockResolvedValue('remote')
    getPRForBranchMock.mockResolvedValue({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix',
          branchIntent: 'create-exact',
          linkedPR: 42,
          pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
        })
      ).rejects.toMatchObject({ code: 'worktree_create_exact_name_taken' })
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      vi.mocked(getBranchConflictKindStrict).mockResolvedValue(null)
      getPRForBranchMock.mockReset()
      gitSpy.mockRestore()
    }
  })
})
