import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getBranchConflictKind,
  getHostedReviewForBranchMock,
  getPRForBranchMock,
  gitRunner,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('creates a same-repo PR branch override from a resolved head SHA and matching push target', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getBranchConflictKind).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix', 'abc123')
      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['branch', '--set-upstream-to', 'origin/feature/fix', 'feature/fix'],
        { cwd: createdWorktree.path }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/fix'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('skips broad remote fetch for an existing full-SHA PR base', async () => {
    const runtime = new OrcaRuntimeService(store)
    const sha = 'c'.repeat(40)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: sha,
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'rev-parse' && args.includes(`${sha}^{commit}`)) {
        return { stdout: `${sha}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: sha,
        branchNameOverride: 'feature/fix'
      })

      expect(gitSpy).not.toHaveBeenCalledWith(['fetch', 'origin'], expect.anything())
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        sha,
        false
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/fix'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a selected Bitbucket PR branch override from a matching remote branch', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/bitbucket-title',
      head: 'abc123',
      branch: 'refs/heads/feature/bitbucket',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'bitbucket',
      number: 11,
      title: 'Bitbucket PR',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/11',
      status: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'bitbucket-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/bitbucket',
        linkedBitbucketPR: 11,
        pushTarget: { remoteName: 'origin', branchName: 'feature/bitbucket' }
      })

      expect(getBranchConflictKind).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'feature/bitbucket',
        'abc123'
      )
      expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: TEST_REPO_PATH,
          branch: 'feature/bitbucket',
          linkedBitbucketPR: 11
        })
      )
      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/bitbucket',
        'abc123',
        false
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/bitbucket',
        linkedBitbucketPR: 11
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes an existing PR when a matching push target lacks selected PR metadata', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Existing PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes a matching push target branch when selected PR metadata has no PR number', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: null,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes a matching push target branch when the existing PR is different', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 43,
      title: 'Different PR',
      state: 'open',
      url: 'https://example.com/pr/43',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes a selected PR remote conflict when the PR lookup fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockRejectedValueOnce(new Error('gh unavailable'))
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('checks out an unused runtime PR branch only when it is at the resolved head SHA', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockClear()
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false,
        false,
        { checkoutExistingBranch: true }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes only the runtime worktree path when an exact PR branch checkout path exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation((sanitizedName: string) =>
      sanitizedName === 'fix-title' ? process.cwd() : `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockClear()
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false,
        false,
        { checkoutExistingBranch: true }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })
})
