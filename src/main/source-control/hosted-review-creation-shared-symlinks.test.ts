import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createGitHubPullRequestMock,
  getRepoSlugMock,
  getProjectSlugMock,
  getBitbucketRepoSlugMock,
  getAzureDevOpsRepoSlugMock,
  getGiteaRepoSlugMock,
  getEnterpriseGitHubRepoSlugMock,
  getHostedReviewForBranchMock,
  ghExecFileAsyncMock,
  glabExecFileAsyncMock,
  gitExecFileAsyncMock,
  getUpstreamStatusMock
} = vi.hoisted(() => ({
  createGitHubPullRequestMock: vi.fn(),
  getRepoSlugMock: vi.fn(),
  getProjectSlugMock: vi.fn(),
  getBitbucketRepoSlugMock: vi.fn(),
  getAzureDevOpsRepoSlugMock: vi.fn(),
  getGiteaRepoSlugMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getUpstreamStatusMock: vi.fn()
}))

vi.mock('../github/client', () => ({
  createGitHubPullRequest: createGitHubPullRequestMock,
  getRepoSlug: getRepoSlugMock,
  getPRForBranch: vi.fn()
}))
vi.mock('../github/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock
}))
vi.mock('../gitlab/client', () => ({
  getProjectSlug: getProjectSlugMock,
  getMergeRequestForBranch: vi.fn(),
  getMergeRequest: vi.fn()
}))
vi.mock('../gitlab/merge-request-creation', () => ({ createGitLabMergeRequest: vi.fn() }))
vi.mock('../bitbucket/client', () => ({
  getBitbucketRepoSlug: getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranch: vi.fn(),
  getBitbucketPullRequest: vi.fn()
}))
vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsRepoSlug: getAzureDevOpsRepoSlugMock,
  getAzureDevOpsPullRequestForBranch: vi.fn(),
  getAzureDevOpsPullRequest: vi.fn()
}))
vi.mock('../azure-devops/pull-request-creation', () => ({
  createAzureDevOpsPullRequest: vi.fn(),
  isAzureDevOpsReviewCreationAuthenticated: vi.fn()
}))
vi.mock('../gitea/client', () => ({
  getGiteaRepoSlug: getGiteaRepoSlugMock,
  getGiteaPullRequestForBranch: vi.fn(),
  getGiteaPullRequest: vi.fn()
}))
vi.mock('../gitea/pull-request-creation', () => ({
  createGiteaPullRequest: vi.fn(),
  isGiteaReviewCreationAuthenticated: vi.fn()
}))
vi.mock('../github/gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../gitlab/gl-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  glabExecFileAsync: glabExecFileAsyncMock,
  glabRepoExecOptions: (repoPath: string) => ({ cwd: repoPath })
}))
vi.mock('../git/upstream', () => ({
  getUpstreamStatus: getUpstreamStatusMock
}))
vi.mock('./hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

import { createHostedReview } from './hosted-review-creation'

// Directory-only ignores miss worktree symlinks; exclude Orca-owned links rather than demand an impossible commit.
describe('createHostedReview with shared symlinks', () => {
  let worktree: string
  let statusOutput: string

  const createPr = (sharedLinkPaths?: string[]): ReturnType<typeof createHostedReview> =>
    createHostedReview(
      worktree,
      { provider: 'github', base: 'main', head: 'feature', title: 'Feature' },
      'local',
      sharedLinkPaths ? { sharedLinkPaths } : {}
    )

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'orca-hosted-shared-'))
    mkdirSync(join(worktree, 'primary-node-modules'))
    symlinkSync(join(worktree, 'primary-node-modules'), join(worktree, 'node_modules'), 'dir')
    statusOutput = '?? node_modules\0'

    for (const mock of [
      createGitHubPullRequestMock,
      getRepoSlugMock,
      getProjectSlugMock,
      getBitbucketRepoSlugMock,
      getAzureDevOpsRepoSlugMock,
      getGiteaRepoSlugMock,
      getEnterpriseGitHubRepoSlugMock,
      getHostedReviewForBranchMock,
      ghExecFileAsyncMock,
      glabExecFileAsyncMock,
      gitExecFileAsyncMock,
      getUpstreamStatusMock
    ]) {
      mock.mockReset()
    }

    getProjectSlugMock.mockResolvedValue(null)
    getRepoSlugMock.mockResolvedValue({ owner: 'acme', repo: 'orca' })
    getBitbucketRepoSlugMock.mockResolvedValue(null)
    getAzureDevOpsRepoSlugMock.mockResolvedValue(null)
    getGiteaRepoSlugMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    getHostedReviewForBranchMock.mockResolvedValue(null)
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    glabExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    getUpstreamStatusMock.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 0
    })
    createGitHubPullRequestMock.mockResolvedValue({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'status') {
        return { stdout: statusOutput, stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: 'Feature title\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  it('blocks creation when the shared symlink is not declared', async () => {
    await expect(createPr()).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'validation' })
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('creates the pull request when the untracked entry is a declared shared symlink', async () => {
    await expect(createPr(['node_modules'])).resolves.toEqual({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/pull/12'
    })
    expect(createGitHubPullRequestMock).toHaveBeenCalledOnce()
  })

  it('still blocks when a genuine untracked file sits beside the shared symlink', async () => {
    statusOutput = '?? node_modules\0?? scratch.txt\0'

    await expect(createPr(['node_modules'])).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'validation' })
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('still blocks on a modified tracked file beside the shared symlink', async () => {
    statusOutput = '?? node_modules\0 M src/app.ts\0'

    await expect(createPr(['node_modules'])).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'validation' })
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  // A configured shared name holding a regular file remains user work.
  it('still blocks when a declared name exists as a regular file', async () => {
    writeFileSync(join(worktree, 'notes'), 'user work\n')
    statusOutput = '?? notes\0'

    await expect(createPr(['node_modules', 'notes'])).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'validation' })
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  // Tracked changes remain committable user work even at declared shared paths.
  it('still blocks on a tracked change at the declared shared path', async () => {
    symlinkSync(join(worktree, 'primary-node-modules'), join(worktree, 'tracked-link'), 'dir')
    statusOutput = '?? node_modules\0 M tracked-link\0'

    await expect(createPr(['node_modules', 'tracked-link'])).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'validation' })
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })

  it('does not mistake a rename origin for an untracked shared path', async () => {
    // Consume rename origin fields so they cannot masquerade as untracked shared links.
    statusOutput = 'R  renamed.txt\0node_modules\0'

    await expect(createPr(['node_modules'])).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'validation' })
    )
    expect(createGitHubPullRequestMock).not.toHaveBeenCalled()
  })
})
