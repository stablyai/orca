import { beforeEach, expect, it, vi } from 'vitest'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ghExecFileAsync: exec
}))
vi.mock('../../api/rate-limit', () => ({
  noteRepositoryRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: () => ({ blocked: false }),
  spendsSharedGitHubComQuota: () => false
}))
import { readCompletePRCheckObservation } from './complete-pr-check-observation'
import { summarizePRCheckRollup } from '../../../../shared/source-control/checks/pr-check-status'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const sha = 'a'.repeat(40)
const success = {
  __typename: 'CheckRun',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  checkSuite: { databaseId: 7 }
}
const failure = { ...success, conclusion: 'FAILURE' }
const connection = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor }
})
function page(
  contexts: unknown[],
  suites: unknown[] = [],
  checksCursor: string | null = null,
  suitesCursor: string | null = null,
  head = sha
) {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 42,
            headRefOid: head,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: head,
                    statusCheckRollup: { contexts: connection(contexts, checksCursor) },
                    checkSuites: connection(suites, suitesCursor)
                  }
                }
              ]
            }
          }
        }
      }
    })
  }
}
const read = () => readCompletePRCheckObservation(repository, 42, sha, { cwd: '/repo' })
beforeEach(() => vi.resetAllMocks())

it('counts a hidden failure and suite-only blocker after both first pages without counting a represented suite twice', async () => {
  exec
    .mockResolvedValueOnce(
      page(
        Array.from({ length: 100 }, () => success),
        [{ databaseId: 7, conclusion: 'ACTION_REQUIRED' }],
        'checks-2',
        'suites-2'
      )
    )
    .mockResolvedValueOnce(page([failure]))
    .mockResolvedValueOnce(page([], [{ databaseId: 8, conclusion: 'ACTION_REQUIRED' }]))
  const rollup = await read()
  expect(summarizePRCheckRollup(rollup!)).toEqual({
    state: 'failure',
    total: 102,
    passed: 100,
    failed: 2,
    cancelled: 0,
    pending: 0,
    neutral: 0
  })
})

it.each(['failed-page', 'changed-head', 'broken-cursor'])(
  'never certifies the successful prefix after %s',
  async (kind) => {
    exec.mockResolvedValueOnce(page([success], [], 'checks-2'))
    if (kind === 'failed-page') {
      exec.mockRejectedValueOnce(new Error('Unavailable'))
    } else {
      exec.mockResolvedValueOnce(
        page(
          [success],
          [],
          kind === 'broken-cursor' ? 'checks-2' : null,
          null,
          kind === 'changed-head' ? 'b'.repeat(40) : sha
        )
      )
    }
    exec.mockRejectedValue(new Error('REST unavailable'))
    expect(await read()).toBeUndefined()
  }
)

it('recovers every REST page and endpoint before publishing a full verdict', async () => {
  exec.mockImplementation(async (args: string[]) => {
    if (args.includes('graphql')) {
      throw new Error('GraphQL unavailable')
    }
    const path = args.at(-1)!
    expect(args).not.toContain('--cache')
    if (path.includes('/check-runs?')) {
      return {
        stdout: JSON.stringify({
          total_count: 101,
          check_runs: path.endsWith('page=1')
            ? Array.from({ length: 100 }, () => ({
                status: 'completed',
                conclusion: 'success',
                check_suite: { id: 7 }
              }))
            : [{ status: 'completed', conclusion: 'cancelled', check_suite: { id: 7 } }]
        })
      }
    }
    if (path.includes('/status?')) {
      return {
        stdout: JSON.stringify({ total_count: 1, statuses: [{ state: 'failure', context: '' }] })
      }
    }
    return {
      stdout: JSON.stringify({
        total_count: 1,
        check_suites: [{ id: 8, status: 'completed', conclusion: 'action_required' }]
      })
    }
  })
  expect(summarizePRCheckRollup((await read())!)).toEqual({
    state: 'failure',
    total: 103,
    passed: 100,
    failed: 3,
    cancelled: 1,
    pending: 0,
    neutral: 0
  })
})

it('distinguishes exhausted empty REST collections from a missing required subread', async () => {
  let failStatuses = false
  exec.mockImplementation(async (args: string[]) => {
    if (args.includes('graphql') || (failStatuses && args.at(-1)!.includes('/status?'))) {
      throw new Error('Unavailable')
    }
    return {
      stdout: JSON.stringify({ total_count: 0, check_runs: [], statuses: [], check_suites: [] })
    }
  })
  expect(await read()).toEqual([])
  failStatuses = true
  expect(await read()).toBeUndefined()
})
