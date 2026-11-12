import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exec, spend } = vi.hoisted(() => ({ exec: vi.fn(), spend: vi.fn() }))
vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: exec
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: vi.fn()
}))
vi.mock('./rate-limit', () => ({
  noteRepositoryRateLimitSpend: spend,
  repositoryRateLimitGuard: () => ({ blocked: false }),
  spendsSharedGitHubComQuota: () => false
}))

import { getPRByNumber, lookupPRByNumber } from './client/lookup/pr-number-lookup'
import { _resetPRStackSummaryCacheForTests } from './client/lookup/pr-stack-summary-cache'
import { _resetMergeQueueCacheForTests } from './client/detect/repository-merge-metadata-cache'
import { readPullRequestSidebarQuery } from './client/lookup/pull-request-sidebar-query'
import { createImplicitDefaultBranchPRPolicy } from './client/lookup/implicit-default-branch-pr'
import { deriveCheckStatus } from './mappers'

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
  it('rejects a deleted fork from the parsed number query when head identity is unknown', async () => {
    exec.mockResolvedValueOnce(
      response({ ...fields, isCrossRepository: true, headRepository: null })
    )
    const policy = createImplicitDefaultBranchPRPolicy({
      originHeadRepo: null,
      trackedUpstream: null,
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

  it.each([
    { data: { repository: { pullRequest: { ...fields, number: 99 } } } },
    {
      data: { repository: { pullRequest: fields } },
      errors: [{ path: ['repository', 'pullRequest', 'headRefOid'] }]
    },
    { data: { repository: { pullRequest: fields } }, errors: [{ message: 'Unscoped failure' }] }
  ])('falls back to the rich CLI read for an unusable response', async (envelope) => {
    exec.mockResolvedValueOnce({ stdout: JSON.stringify(envelope) }).mockResolvedValueOnce({
      stdout: JSON.stringify({ ...fields, title: 'CLI fallback', statusCheckRollup: [] })
    })
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      title: 'CLI fallback'
    })
    expect(exec.mock.calls[1][0].slice(0, 2)).toEqual(['pr', 'view'])
  })
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

it.each([1, 10])(
  'reuses combined exact hydration with independent context and suite populations at N=%i',
  async (n) => {
    const contextPages = 2 * n
    const suitePages = 3 * n
    exec.mockImplementation(async (args: string[]) => {
      const contextCursor = args.find((arg) => arg.startsWith('checksCursor='))
      const suiteCursor = args.find((arg) => arg.startsWith('suitesCursor='))
      const contextIndex = contextCursor ? Number(contextCursor.split('=')[1]) : 0
      const suiteIndex = suiteCursor ? Number(suiteCursor.split('=')[1]) : 0
      const lastContext = contextIndex === contextPages - 1
      const commit = {
        oid: fields.headRefOid,
        ...(!suiteCursor
          ? {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    lastContext ? { __typename: 'StatusContext', state: 'FAILURE' } : successCheck
                  ],
                  pageInfo: {
                    hasNextPage: !lastContext,
                    endCursor: lastContext ? null : String(contextIndex + 1)
                  }
                }
              }
            }
          : {}),
        ...(!contextCursor
          ? {
              checkSuites: {
                nodes: [{ databaseId: suiteIndex + 1, conclusion: 'SUCCESS' }],
                pageInfo: {
                  hasNextPage: suiteIndex < suitePages - 1,
                  endCursor: suiteIndex < suitePages - 1 ? String(suiteIndex + 1) : null
                }
              }
            }
          : {})
      }
      return response({ ...fields, commits: { nodes: [{ commit }] } })
    })
    const known = {
      ...fields,
      stack: undefined,
      statusCheckRollup: [],
      headDefaultBranchName: 'trunk'
    }
    const observed = await getPRByNumber(repository, 42, options, 'local:host', known)
    expect(observed).toMatchObject({ headDefaultBranchName: 'trunk', checksUnavailable: false })
    expect(observed?.statusCheckRollup).toHaveLength(contextPages)
    expect(observed?.statusCheckRollup?.at(-1)).toEqual({
      __typename: 'StatusContext',
      state: 'FAILURE'
    })
    expect(exec).toHaveBeenCalledTimes(1 + (contextPages - 1) + (suitePages - 1))
    expect(exec.mock.calls.every(([args]) => args[0] === 'api' && args[1] === 'graphql')).toBe(true)
  }
)
