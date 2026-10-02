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

const { ghExecFileAsyncMock, getOwnerRepoMock, gitExecFileAsyncMock } = clientMocks

// Why: the conflicting-file list used to come from a background fetch + merge-tree per refresh, which wrote objects into the repo and competed for disk.
const BACKGROUND_MERGE_COMMANDS = new Set(['fetch', 'merge-base', 'rev-list', 'merge-tree'])

function backgroundMergeCalls(): unknown[][] {
  return gitExecFileAsyncMock.mock.calls.filter(([args]) => {
    const argv: unknown[] = Array.isArray(args) ? args : []
    return argv.some((arg) => typeof arg === 'string' && BACKGROUND_MERGE_COMMANDS.has(arg))
  })
}

describe('getPRForBranch for a conflicting PR', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
  })

  it.each([
    { label: 'a local repo', options: undefined },
    { label: 'a WSL repo', options: { localGitExecOptions: { wslDistro: 'Ubuntu' } } }
  ])(
    'reports the host conflict and base branch without running a practice merge in $label',
    async ({ options }) => {
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Fix PR discovery',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/42',
            updated_at: '2026-09-30T00:00:00Z',
            draft: false,
            mergeable_state: 'dirty',
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'feature/test', sha: 'head-oid' }
          }
        ])
      })

      const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, null, options)

      expect(pr?.mergeable).toBe('CONFLICTING')
      expect(pr?.baseRefName).toBe('main')
      expect(pr).not.toHaveProperty('conflictSummary')
      expect(backgroundMergeCalls()).toEqual([])
    }
  )

  it('treats a DIRTY merge state as conflicting while gh pr view still reports UNKNOWN', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-09-30T00:00:00Z',
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

    const pr = await getPRForBranch('/repo-root', 'feature/test', 42)

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.baseRefName).toBe('main')
    expect(backgroundMergeCalls()).toEqual([])
  })
})
