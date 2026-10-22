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

import { getPRRelandings } from './client/fetch/get-pr-relandings'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'

const { ghExecFileAsyncMock, getOwnerRepoMock } = clientMocks

function crossReference(number: number, merged: boolean, mergedAt: string | null) {
  return {
    __typename: 'CrossReferencedEvent',
    source: {
      __typename: 'PullRequest',
      number,
      title: `PR ${number}`,
      url: `https://github.com/stablyai/orca/pull/${number}`,
      merged,
      mergedAt,
      author: { login: 'nwparker' }
    }
  }
}

describe('getPRRelandings', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
  })

  it('lists the merged PRs that reference a closed PR, newest merge first', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              timelineItems: {
                nodes: [
                  crossReference(26942, true, '2026-10-11T02:00:00Z'),
                  crossReference(26950, false, null),
                  {
                    __typename: 'CrossReferencedEvent',
                    source: { __typename: 'Issue', number: 26477 }
                  },
                  crossReference(27001, true, '2026-10-12T02:00:00Z'),
                  crossReference(26942, true, '2026-10-11T02:00:00Z')
                ]
              }
            }
          }
        }
      })
    })

    await expect(getPRRelandings('/repo-root', 26497)).resolves.toEqual([
      {
        number: 27001,
        title: 'PR 27001',
        url: 'https://github.com/stablyai/orca/pull/27001',
        author: 'nwparker',
        mergedAt: '2026-10-12T02:00:00Z'
      },
      {
        number: 26942,
        title: 'PR 26942',
        url: 'https://github.com/stablyai/orca/pull/26942',
        author: 'nwparker',
        mergedAt: '2026-10-11T02:00:00Z'
      }
    ])
  })

  it('returns nothing when the lookup fails', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('gh: HTTP 502'))

    await expect(getPRRelandings('/repo-root', 26497)).resolves.toEqual([])
  })
})
