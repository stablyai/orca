import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getPRForBranch } from './client'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('derives a read-only conflict summary for conflicting PRs when the base ref exists locally', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
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

  it('routes local WSL branch status and conflict summary git probes through the selected distro', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-06-16T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
    expect(resolvePRRepositoryCandidatesMock).toHaveBeenCalledWith('/repo-root', null, {
      wslDistro: 'Ubuntu'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        cwd: '/repo-root',
        wslDistro: 'Ubuntu'
      })
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['fetch', '--quiet', 'origin', 'main'],
      {
        cwd: '/repo-root',
        timeout: 10_000,
        wslDistro: 'Ubuntu'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        'merge-base-oid',
        'head-oid',
        'latest-base-oid'
      ],
      {
        cwd: '/repo-root',
        wslDistro: 'Ubuntu'
      }
    )
  })

  it('treats GitHub DIRTY merge state as conflicting when mergeable is still unknown', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'DIRTY',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: null } } })
      })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 42)

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('omits conflict summaries for SSH-backed repos', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/remote/repo-root', 'feature/test', undefined, 'ssh-1')

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary).toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps conflicted file paths when git merge-tree exits 1 with stdout', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
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

  it('falls back to the legacy merge-tree invocation when Git lacks --merge-base', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stderr: "error: unknown option `merge-base'"
      })
      .mockRejectedValueOnce({
        stdout: 'result-tree-oid\u0000src/conflict.ts\u0000'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        'merge-base-oid',
        'head-oid',
        'latest-base-oid'
      ],
      { cwd: '/repo-root' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        'head-oid',
        'latest-base-oid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('skips the unsupported merge-tree --merge-base retry after the first capability miss', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    const branchLookup = {
      number: 42,
      title: 'Fix PR discovery',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/pull/42',
      updated_at: '2026-03-28T00:00:00Z',
      draft: false,
      mergeable_state: 'dirty',
      base: { ref: 'main', sha: 'base-oid' },
      head: { ref: 'feature/test', sha: 'head-oid' }
    }
    const exactLookup = {
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
    // Why a second head OID: identical inputs now hit the summary result
    // cache outright; a pushed head re-derives and must still skip the
    // unsupported --merge-base retry via the capability cache.
    const pushedBranchLookup = { ...branchLookup, head: { ref: 'feature/test', sha: 'head-oid-2' } }
    const pushedExactLookup = { ...exactLookup, headRefOid: 'head-oid-2' }
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([branchLookup]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(exactLookup) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([pushedBranchLookup]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(pushedExactLookup) })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({ stderr: "error: unknown option `merge-base'" })
      .mockRejectedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    await getPRForBranch('/repo-root', 'feature/test')
    await getPRForBranch('/repo-root', 'feature/test')

    const modernMergeTreeCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('--merge-base')
    )
    const legacyMergeTreeCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) => {
      const argv = args as string[]
      return argv[0] === 'merge-tree' && !argv.includes('--merge-base')
    })

    expect(modernMergeTreeCalls).toHaveLength(1)
    expect(legacyMergeTreeCalls).toHaveLength(2)
  })

  it('does not retry legacy merge-tree for older Git failures unrelated to --merge-base', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stderr: 'usage: git merge-tree <base-tree> <branch1> <branch2>'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(5)
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        'merge-base-oid',
        'head-oid',
        'latest-base-oid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary).toBeUndefined()
  })

  it('marks the conflict summary as locally clean when GitHub reports dirty but merge-tree has no conflicted files', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-06-20T22:16:43Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'latest-',
      commitsBehind: 1,
      files: [],
      localMergeState: 'clean'
    })
  })

  it('falls back to GitHub baseRefOid when fetching or resolving the base ref fails', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
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
})
