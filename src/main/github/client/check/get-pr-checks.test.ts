import { expect, it, vi } from 'vitest'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { getPRChecksObservation } from './get-pr-checks'

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ghExecFileAsync: vi.fn()
}))
vi.mock('../../api/rate-limit', () => ({
  noteRepositoryRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: () => ({ blocked: false }),
  spendsSharedGitHubComQuota: () => false
}))

const headSha = 'a'.repeat(40)

function connection(nodes: unknown[], endCursor: string | null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } }
}

function response(commit: Record<string, unknown>) {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: { number: 42, headRefOid: headSha, commits: { nodes: [{ commit }] } }
        }
      }
    }),
    stderr: ''
  }
}

it('returns detailed rows and a complete summary when checks and suites span multiple pages', async () => {
  const build = {
    __typename: 'CheckRun',
    name: 'Build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    checkSuite: { databaseId: 7 }
  }
  vi.mocked(ghExecFileAsync)
    .mockResolvedValueOnce(
      response({
        oid: headSha,
        statusCheckRollup: { contexts: connection([build], 'checks-2') },
        checkSuites: connection([{ databaseId: 7, conclusion: 'ACTION_REQUIRED' }], 'suites-2')
      })
    )
    .mockResolvedValueOnce(
      response({
        oid: headSha,
        statusCheckRollup: {
          contexts: connection(
            [
              {
                ...build,
                databaseId: 37,
                name: 'Integration tests',
                conclusion: 'FAILURE',
                detailsUrl: 'https://ci.example.org/results/37',
                checkSuite: { databaseId: 7, workflowRun: { databaseId: 81 } }
              }
            ],
            null
          )
        }
      })
    )
    .mockResolvedValueOnce(
      response({
        oid: headSha,
        checkSuites: connection(
          [{ databaseId: 8, conclusion: 'ACTION_REQUIRED', app: { name: 'GitHub Actions' } }],
          null
        )
      })
    )

  const result = await getPRChecksObservation('/repo', 42, headSha, {
    owner: 'acme',
    repo: 'widgets',
    host: 'github.com'
  })
  expect(result.checks).toMatchObject([
    { name: 'Build', conclusion: 'success' },
    {
      name: 'Integration tests',
      conclusion: 'failure',
      url: 'https://ci.example.org/results/37',
      checkRunId: 37,
      workflowRunId: 81,
      observedHeadSha: headSha
    },
    { name: 'GitHub Actions #8', conclusion: 'action_required' }
  ])
  expect(result.summary?.value).toEqual({
    state: 'failure',
    total: 3,
    passed: 1,
    failed: 1,
    cancelled: 0,
    pending: 1,
    actionRequired: 1,
    neutral: 0
  })
})
