/* oxlint-disable max-lines -- Why: GitHub client fixtures cover local and SSH repo identity paths in one suite so mocked CLI behavior stays consistent. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getRemoteUrlForRepoMock,
  gitExecFileAsyncMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  ghRepoExecOptionsMock,
  githubRepoContextMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getRemoteUrlForRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  rateLimitGuardMock: vi.fn<() => RateLimitGuardResult>(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  ghRepoExecOptionsMock: vi.fn((context) =>
    context.connectionId ? {} : { cwd: context.repoPath }
  ),
  githubRepoContextMock: vi.fn((repoPath, connectionId) => ({
    repoPath,
    connectionId: connectionId ?? null
  })),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  getRemoteUrlForRepo: getRemoteUrlForRepoMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  ghRepoExecOptions: ghRepoExecOptionsMock,
  githubRepoContext: githubRepoContextMock,
  classifyGhError: (stderr: string) =>
    stderr.toLowerCase().includes('not found') || stderr.includes('HTTP 404')
      ? { type: 'not_found', message: stderr }
      : { type: 'unknown', message: stderr },
  parseGitHubOwnerRepo: (remoteUrl: string) => {
    const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    return match ? { owner: match[1], repo: match[2] } : null
  },
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import {
  getPRComments,
  getPRForBranch,
  getPullRequestPushTarget,
  resolveReviewThread,
  _resetOwnerRepoCache
} from './client'

describe('getPRForBranch', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    ghRepoExecOptionsMock.mockClear()
    githubRepoContextMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('queries GitHub by head branch when the remote is on github.com', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'refs/heads/feature/test')

    expect(getOwnerRepoMock).toHaveBeenCalledWith('/repo-root', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--repo',
        'acme/widgets',
        '--head',
        'feature/test',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.number).toBe(42)
    expect(pr?.state).toBe('open')
    expect(pr?.mergeable).toBe('MERGEABLE')
  })

  it('falls back to REST branch lookup when gh pr list is GraphQL rate limited', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 43,
            title: 'REST branch lookup',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/43',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            head: { ref: 'feature/test', sha: 'rest-head-oid' },
            base: { ref: 'main', sha: 'rest-base-oid' }
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 43,
      title: 'REST branch lookup',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/43',
      checksStatus: 'neutral',
      mergeable: 'MERGEABLE',
      headSha: 'rest-head-oid'
    })
  })

  it('falls back to gh pr view when the remote cannot be resolved to GitHub', async () => {
    getOwnerRepoMock.mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Fallback lookup',
        state: 'OPEN',
        url: 'https://example.com/pr/7',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: true,
        mergeable: 'CONFLICTING',
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/non-github-repo', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        'feature/test',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/non-github-repo' }
    )
    expect(pr?.number).toBe(7)
    expect(pr?.state).toBe('draft')
    expect(pr?.mergeable).toBe('CONFLICTING')
  })

  it('derives a read-only conflict summary for conflicting PRs when the base ref exists locally', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '3\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/a.ts\u0000src/b.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'latest-',
      commitsBehind: 3,
      files: ['src/a.ts', 'src/b.ts']
    })
  })

  it('keeps conflicted file paths when git merge-tree exits 1 with stdout', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stdout: 'result-tree-oid\u0000src/conflict.ts\u0000'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('falls back to GitHub baseRefOid when fetching or resolving the base ref fails', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        }
      ])
    })
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('missing refs/remotes/origin/main'))
      .mockRejectedValueOnce(new Error('missing origin/main'))
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/fallback.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'base-oi',
      commitsBehind: 1,
      files: ['src/fallback.ts']
    })
  })

  it('returns null for empty branch (e.g. during rebase with detached HEAD)', async () => {
    const pr = await getPRForBranch('/repo-root', '')
    expect(pr).toBeNull()
    // Should not call gh at all
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null for refs/heads/ only branch (detached after strip)', async () => {
    const pr = await getPRForBranch('/repo-root', 'refs/heads/')
    expect(pr).toBeNull()
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null when pr list returns an empty array', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const pr = await getPRForBranch('/repo-root', 'no-pr-branch')

    expect(pr).toBeNull()
  })

  it('falls back to REST number lookup when linked PR GraphQL lookup is rate limited', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'REST linked PR lookup',
          state: 'closed',
          merged_at: '2026-03-28T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/pull/99',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'clean',
          head: { ref: 'someone/fix', sha: 'linked-head-oid' },
          base: { ref: 'main', sha: 'linked-base-oid' }
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(3, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(pr).toMatchObject({
      number: 99,
      state: 'merged',
      mergeable: 'MERGEABLE',
      headSha: 'linked-head-oid'
    })
  })

  it('resolves fork PR push target using the origin URL protocol', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'prateek/fix-sidebar-agents-toggle',
          repo: {
            full_name: 'prateek/orca',
            name: 'orca',
            clone_url: 'https://github.com/prateek/orca.git',
            ssh_url: 'git@github.com:prateek/orca.git',
            owner: { login: 'prateek' }
          }
        }
      })
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n',
      stderr: ''
    })

    const target = await getPullRequestPushTarget('/repo-root', 1738)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', 'repos/stablyai/orca/pulls/1738'], {
      cwd: '/repo-root'
    })
    expect(target).toEqual({
      remoteName: 'pr-prateek-orca',
      branchName: 'prateek/fix-sidebar-agents-toggle',
      remoteUrl: 'git@github.com:prateek/orca.git'
    })
  })

  it('uses origin for same-repository PR push targets', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'fix-sidebar',
          repo: {
            full_name: 'stablyai/orca',
            name: 'orca',
            clone_url: 'https://github.com/stablyai/orca.git',
            ssh_url: 'git@github.com:stablyai/orca.git',
            owner: { login: 'stablyai' }
          }
        }
      })
    })

    await expect(getPullRequestPushTarget('/repo-root', 1738)).resolves.toEqual({
      remoteName: 'origin',
      branchName: 'fix-sidebar'
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('skips PR review-thread GraphQL fetch while preserving REST comments', async () => {
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 4,
      limit: 5000,
      resetAt: 1_800_000_000
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 10,
            user: { login: 'octo', avatar_url: 'https://avatar', type: 'User' },
            body: 'top-level',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-10'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    const comments = await getPRComments('/repo-root', 7)

    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('top-level')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock.mock.calls.some((call) => call[0][1] === 'graphql')).toBe(false)
    expect(noteRateLimitSpendMock).not.toHaveBeenCalled()
  })

  it('blocks review-thread resolve mutations before spawning gh when GraphQL is low', async () => {
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 4,
      limit: 5000,
      resetAt: 1_800_000_000
    })

    await expect(resolveReviewThread('/repo-root', 'thread-1', true)).resolves.toBe(false)

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(noteRateLimitSpendMock).not.toHaveBeenCalled()
  })
})
