import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
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

import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { resetPRForBranchMocks } from './client-test-harness'

const { ghExecFileAsyncMock, getOwnerRepoMock, noteRateLimitSpendMock } = clientMocks

describe('PR lookup conditional REST reads', () => {
  beforeEach(() => resetPRForBranchMocks(clientMocks))

  it('refreshes a missing branch immediately at zero primary cost when GitHub confirms it is unchanged', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'HTTP/2.0 200 OK\nEtag: "v1"\r\n\r\n[]' })
      .mockRejectedValueOnce(
        Object.assign(new Error('gh: HTTP 304'), { stdout: 'HTTP/2.0 304 Not Modified\n\n' })
      )
    expect((await getPRForBranchOutcome('/repo', 'feature/missing')).kind).toBe('no-pr')
    expect((await getPRForBranchOutcome('/repo', 'feature/missing')).kind).toBe('no-pr')
    expect(ghExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      [
        'api',
        'repos/acme/widgets/pulls?head=acme%3Afeature%2Fmissing&state=all&per_page=1',
        '--include'
      ],
      [
        'api',
        'repos/acme/widgets/pulls?head=acme%3Afeature%2Fmissing&state=all&per_page=1',
        '--include',
        '-H',
        'If-None-Match: "v1"'
      ]
    ])
    expect(noteRateLimitSpendMock.mock.calls).toEqual([['core']])
  })
})
