import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exec, spend } = vi.hoisted(() => ({ exec: vi.fn(), spend: vi.fn() }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: exec
}))

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: vi.fn()
}))
vi.mock('../../api/rate-limit', () => ({
  noteRepositoryRateLimitSpend: spend,
  repositoryRateLimitGuard: () => ({ blocked: false }),
  spendsSharedGitHubComQuota: () => false
}))

import { getPRByNumber, lookupPRByNumber } from './pr-number-lookup'
import { _resetPRStackSummaryCacheForTests } from './pr-stack-summary-cache'
import { _resetMergeQueueCacheForTests } from '../detect/repository-merge-metadata-cache'
import { readPullRequestSidebarQuery } from './pull-request-sidebar-query'
import { createImplicitDefaultBranchPRPolicy } from './implicit-default-branch-pr'
import { derivePRCheckStatusFromRollup as deriveCheckStatus } from '../../../../shared/source-control/checks/pr-check-status'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const options = { cwd: '/folder-workspace' }
const successCheck = { __typename: 'StatusContext', state: 'SUCCESS' }

function commits(checks: unknown[] = [successCheck], endCursor?: string, oid = 'b'.repeat(40)) {
  return {
    nodes: [
      {
        commit: {
          oid,
          checkSuites: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          statusCheckRollup: {
            contexts: {
              nodes: checks.map((raw) =>
                raw &&
                typeof raw === 'object' &&
                '__typename' in raw &&
                raw.__typename === 'CheckRun'
                  ? { ...raw, checkSuite: { databaseId: 7 } }
                  : raw
              ),
              pageInfo: { hasNextPage: Boolean(endCursor), endCursor: endCursor ?? null }
            }
          }
        }
      }
    ]
  }
}
const fields = {
  number: 42,
  title: 'Keep sidebar metadata together',
  state: 'CLOSED',
  url: 'https://github.com/acme/widgets/pull/42',
  updatedAt: '2026-10-28T00:00:00Z',
  isDraft: false,
  mergeable: 'UNKNOWN',
  reviewDecision: null,
  mergeStateStatus: 'UNKNOWN',
  autoMergeRequest: null,
  baseRefName: 'main',
  headRefName: 'feature/sidebar',
  baseRefOid: 'a'.repeat(40),
  headRefOid: 'b'.repeat(40),
  headRepositoryOwner: { login: 'contributor' },
  headRepository: { name: 'widgets' },
  commits: commits(),
  stack: null,
  stackEntry: null
}

function response(pr: Record<string, unknown> = fields, errors?: unknown[]) {
  return { stdout: JSON.stringify({ data: { repository: { pullRequest: pr } }, errors }) }
}

beforeEach(() => {
  vi.resetAllMocks()
  _resetPRStackSummaryCacheForTests()
  _resetMergeQueueCacheForTests()
})

describe('sidebar PR query', () => {
  it('keeps each linked review and an absent review distinct in one reply', async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            pr0: fields,
            pr1: {
              ...fields,
              number: 43,
              title: 'Another attached review',
              url: 'https://github.com/acme/widgets/pull/43',
              commits: commits([{ __typename: 'StatusContext', state: 'FAILURE' }])
            },
            pr2: null
          }
        },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'pr2'] }]
      })
    })

    const [first, second, missing] = await Promise.all(
      [42, 43, 44].map((number) =>
        getPRByNumber(repository, number, options, 'local:host', undefined, {
          includeStackSummary: true,
          batchSidebar: true
        })
      )
    )

    expect(first).toMatchObject({ number: 42, title: 'Keep sidebar metadata together' })
    expect(deriveCheckStatus(first?.statusCheckRollup)).toBe('success')
    expect(second).toMatchObject({ number: 43, title: 'Another attached review' })
    expect(deriveCheckStatus(second?.statusCheckRollup)).toBe('failure')
    expect(missing).toBeNull()
  })

  it('rejects a deleted fork from the parsed number query when head identity is unknown', async () => {
    exec.mockResolvedValueOnce(
      response({ ...fields, isCrossRepository: true, headRepository: null })
    )
    const policy = createImplicitDefaultBranchPRPolicy({
      originHeadRepo: null,
      secondaryHeads: [],
      branchName: fields.headRefName,
      repoPath: '/folder-workspace',
      localGitOptions: {},
      ghOptions: options
    })
    expect(
      await lookupPRByNumber({
        candidates: [repository],
        number: 42,
        ghOptions: options,
        executionScope: 'local:host',
        policy
      })
    ).toEqual({ data: null, dataRepo: null })
    expect([...policy.rejectedPRUrls]).toEqual([fields.url])
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('retains PR metadata but never certifies a successful prefix after continuation failure', async () => {
    exec
      .mockResolvedValueOnce(response({ ...fields, commits: commits([successCheck], 'next') }))
      .mockRejectedValue(new Error('Unavailable'))
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      number: 42,
      title: fields.title,
      checksUnavailable: true,
      statusCheckRollup: []
    })
  })

  it('offers the merge methods of the branch the stack merges into', async () => {
    const rules = { main: ['SQUASH'], 'feature/a': ['MERGE'] }
    exec.mockImplementation(async (args: string[]) => {
      if (!args.includes('branch=main') && !args.includes('branch=feature/a')) {
        return response({
          ...fields,
          state: 'OPEN',
          baseRefName: 'feature/a',
          stack: { number: 7, size: 2, baseRefName: 'main' },
          stackEntry: { position: 2 }
        })
      }
      const branch = args.includes('branch=main') ? 'main' : 'feature/a'
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: 'MERGE',
              mergeCommitAllowed: true,
              rebaseMergeAllowed: false,
              squashMergeAllowed: true,
              autoMergeAllowed: true,
              mergeQueue: null,
              ref: {
                rules: {
                  nodes: [
                    { type: 'PULL_REQUEST', parameters: { allowedMergeMethods: rules[branch] } }
                  ]
                }
              }
            }
          }
        })
      }
    })
    const data = await getPRByNumber(repository, 42, options, 'local:host', undefined, {
      includeStackSummary: true
    })
    expect(data?.stack?.baseRefName).toBe('main')
    expect(data?.mergeMethodSettings).toEqual({
      defaultMethod: 'squash',
      allowedMethods: { squash: true, merge: false, rebase: false }
    })
  })

  it('keeps a failure beyond the first 100 checks and reuses the first page', async () => {
    const failingCheck = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }
    exec
      .mockResolvedValueOnce(
        response({
          ...fields,
          commits: commits(
            Array.from({ length: 100 }, () => successCheck),
            'next'
          )
        })
      )
      .mockResolvedValueOnce(
        response({ number: 42, headRefOid: fields.headRefOid, commits: commits([failingCheck]) })
      )
    const data = await getPRByNumber(repository, 42, options, 'local:host', undefined, {
      includeStackSummary: true
    })
    expect(data?.statusCheckRollup).toHaveLength(101)
    expect(deriveCheckStatus(data?.statusCheckRollup)).toBe('failure')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0]).toContain('checksCursor=next')
    expect(exec.mock.calls[1][0].join(' ')).not.toContain('stackEntry')
  })

  it.each([
    { number: 42, headRefOid: fields.headRefOid, commits: commits([], 'next') },
    { number: 42, headRefOid: fields.headRefOid, commits: commits([], undefined, 'c'.repeat(40)) }
  ])(
    'keeps metadata without a certified summary when checks pagination stops advancing or the commit changes',
    async (nextPage) => {
      exec
        .mockResolvedValueOnce(response({ ...fields, commits: commits([successCheck], 'next') }))
        .mockResolvedValueOnce(response(nextPage))
        .mockRejectedValue(new Error('Unavailable'))
      const data = await getPRByNumber(repository, 42, options, 'local:host', undefined, {
        includeStackSummary: true
      })
      expect(data).toMatchObject({
        number: 42,
        title: fields.title,
        checksUnavailable: true,
        statusCheckRollup: []
      })
    }
  )
})

it.each([
  { checks: [null], errors: undefined },
  {
    checks: [{ __typename: 'CheckRun', status: 'FUTURE_STATUS', conclusion: null }],
    errors: undefined
  },
  {
    checks: [successCheck],
    errors: [
      { path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'] }
    ]
  }
])(
  'keeps valid metadata and stack when strict checks are unavailable: %j',
  async ({ checks, errors }) => {
    exec.mockResolvedValueOnce(
      response(
        {
          ...fields,
          commits: commits(checks),
          stack: { number: 7, size: 2, baseRefName: 'main' },
          stackEntry: { position: 1 }
        },
        errors
      )
    )
    await expect(readPullRequestSidebarQuery(repository, 42, options)).resolves.toMatchObject({
      title: fields.title,
      checksUnavailable: true,
      stackMetadataChecked: true,
      stack: { number: 7, size: 2, position: 1 }
    })
  }
)
