import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exec, spend } = vi.hoisted(() => ({ exec: vi.fn(), spend: vi.fn() }))
vi.mock('../git/runner', () => ({ ghExecFileAsync: exec, gitExecFileAsync: vi.fn() }))
vi.mock('./rate-limit', () => ({
  noteRepositoryRateLimitSpend: spend,
  repositoryRateLimitGuard: () => ({ blocked: false })
}))

import { getPRByNumber, lookupPRByNumber } from './client/lookup/pr-number-lookup'
import { derivePRRefreshData } from './client/lookup/branch-lookup-derived-data'
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
          statusCheckRollup: {
            contexts: {
              nodes: checks,
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

function restResponse() {
  return {
    stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({
      number: 42,
      title: fields.title,
      state: 'closed',
      html_url: fields.url,
      head: { sha: fields.headRefOid },
      stack: null
    })}`
  }
}

function legacyResponse() {
  const { commits: _commits, stack: _stack, stackEntry: _entry, ...metadata } = fields
  return { stdout: JSON.stringify({ ...metadata, statusCheckRollup: [successCheck] }) }
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

  it.each(['HTTP 401: Bad credentials', 'HTTP 429: secondary rate limit', 'ETIMEDOUT'])(
    'uses REST recovery directly after %s without another GraphQL attempt',
    async (message) => {
      exec.mockImplementation(async (args: string[]) => {
        if (args.includes('graphql') || args[0] === 'pr') {
          throw new Error(message)
        }
        return restResponse()
      })
      await expect(
        getPRByNumber(repository, 42, options, 'local:host', undefined, {
          includeStackSummary: true
        })
      ).resolves.toMatchObject({
        number: 42
      })
      expect(exec).toHaveBeenCalledTimes(2)
      expect(exec.mock.calls[1][0]).toContain('repos/acme/widgets/pulls/42')
      expect(spend.mock.calls.filter(([, bucket]) => bucket === 'graphql')).toHaveLength(1)
    }
  )

  it.each([true, false])(
    'accepts a scoped NOT_FOUND response without another request (nonzero exit: %s)',
    async (failed) => {
      const missing = {
        stdout: JSON.stringify({
          data: { repository: { pullRequest: null } },
          errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }]
        })
      }
      if (failed) {
        exec.mockRejectedValueOnce({ code: 1, ...missing })
      } else {
        exec.mockResolvedValueOnce(missing)
      }
      await expect(
        getPRByNumber(repository, 42, options, 'local:host', undefined, {
          includeStackSummary: true
        })
      ).resolves.toBeNull()
      expect(exec).toHaveBeenCalledTimes(1)
      expect(spend).toHaveBeenCalledTimes(1)
    }
  )

  it('uses REST recovery directly if a continuation request fails', async () => {
    exec
      .mockResolvedValueOnce(response({ ...fields, commits: commits([successCheck], 'next') }))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(restResponse())
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      number: 42
    })
    expect(exec).toHaveBeenCalledTimes(3)
    expect(exec.mock.calls[2][0]).toContain('repos/acme/widgets/pulls/42')
  })

  it('keeps capability hydration on the PR base before attaching its stack summary', async () => {
    exec
      .mockResolvedValueOnce(
        response({
          ...fields,
          state: 'OPEN',
          stack: { number: 12, size: 3, baseRefName: 'release' },
          stackEntry: { position: 2 }
        })
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: { autoMergeAllowed: true, mergeQueue: null, ref: { rules: { nodes: [] } } }
          }
        })
      })
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      autoMergeAllowed: true,
      stack: { baseRefName: 'release', position: 2 }
    })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0]).toContain('branch=main')
    expect(exec.mock.calls[1][0]).not.toContain('branch=release')
  })

  it('reads linked PR metadata and confirms no stack with one request through the refresh pipeline', async () => {
    exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        return response()
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return legacyResponse()
      }
      if (args[0] === 'api' && args[1] === 'repos/acme/widgets/pulls/42') {
        return restResponse()
      }
      throw new Error(`Unexpected request: ${args.join(' ')}`)
    })

    const { data } = await lookupPRByNumber({
      candidates: [repository],
      number: 42,
      ghOptions: options,
      executionScope: 'local:host'
    })
    if (!data) {
      throw new Error('Expected linked PR')
    }
    const derived = await derivePRRefreshData({
      data,
      dataRepo: repository,
      repoPath: options.cwd,
      localGitOptions: {},
      ghOptions: options,
      executionScope: 'local:host',
      usedExactNumberLookup: true
    })

    expect(exec).toHaveBeenCalledTimes(1)
    expect(spend).toHaveBeenCalledTimes(1)
    expect(data).toMatchObject({
      title: fields.title,
      state: 'CLOSED',
      headRefOid: fields.headRefOid,
      reviewDecision: null,
      autoMergeEnabled: false,
      stackMetadataChecked: true,
      statusCheckRollup: [{ __typename: 'StatusContext', state: 'SUCCESS' }]
    })
    expect(derived).toMatchObject({ stack: undefined, mergeable: 'UNKNOWN' })
  })

  it('does not cache mutable PR fields or delay a later refresh', async () => {
    exec
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ ...fields, title: 'Updated' }))
    await getPRByNumber(repository, 42, options, 'local:host', undefined, {
      includeStackSummary: true
    })
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      title: 'Updated'
    })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('maps stack position and the stack base independently of the PR base', async () => {
    exec.mockResolvedValueOnce(
      response({
        ...fields,
        stack: { number: 12, size: 3, baseRefName: 'release' },
        stackEntry: { position: 2 }
      })
    )
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      baseRefName: 'main',
      stackMetadataChecked: true,
      stack: { number: 12, size: 3, position: 2, baseRefName: 'release' }
    })
    expect(exec).toHaveBeenCalledTimes(1)
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
      .mockResolvedValueOnce(response({ number: 42, commits: commits([null, failingCheck]) }))
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
    { number: 42, commits: commits([], 'next') },
    { number: 42, commits: commits([], undefined, 'c'.repeat(40)) }
  ])(
    'recovers through the rich CLI if checks pagination stops advancing or the commit changes',
    async (nextPage) => {
      exec
        .mockResolvedValueOnce(response({ ...fields, commits: commits([successCheck], 'next') }))
        .mockResolvedValueOnce(response(nextPage))
        .mockResolvedValueOnce(legacyResponse())
      const data = await getPRByNumber(repository, 42, options, 'local:host', undefined, {
        includeStackSummary: true
      })
      expect(deriveCheckStatus(data?.statusCheckRollup)).toBe('success')
      expect(exec).toHaveBeenCalledTimes(3)
      expect(exec.mock.calls[2][0].slice(0, 2)).toEqual(['pr', 'view'])
    }
  )

  it('preserves known branch discovery metadata without adding another query', async () => {
    exec.mockResolvedValueOnce(legacyResponse())
    const known = {
      ...fields,
      statusCheckRollup: [],
      headDefaultBranchName: 'trunk',
      stackMetadataChecked: true,
      stack: undefined
    }
    const data = await getPRByNumber(repository, 42, options, 'local:host', known)
    expect(data).toMatchObject({ headDefaultBranchName: 'trunk', stackMetadataChecked: true })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0][0].slice(0, 2)).toEqual(['pr', 'view'])
  })

  it.each([
    { stack: undefined, stackEntry: undefined },
    { stack: { number: 12, size: 1, baseRefName: 'release' }, stackEntry: { position: 2 } }
  ])(
    'recovers missing or invalid stack metadata through the existing reader',
    async (stackFields) => {
      exec
        .mockResolvedValueOnce(response({ ...fields, ...stackFields }))
        .mockResolvedValueOnce(restResponse())
      const data = await getPRByNumber(repository, 42, options, 'local:host', undefined, {
        includeStackSummary: true
      })
      if (!data) {
        throw new Error('Expected linked PR')
      }
      await derivePRRefreshData({
        data,
        dataRepo: repository,
        repoPath: options.cwd,
        localGitOptions: {},
        ghOptions: options,
        executionScope: 'local:host',
        usedExactNumberLookup: true
      })
      expect(data.stackMetadataChecked).toBe(true)
      expect(exec).toHaveBeenCalledTimes(2)
      expect(exec.mock.calls[1][0]).toContain('repos/acme/widgets/pulls/42')
    }
  )

  it('retains usable metadata from a stack field error on a nonzero gh exit', async () => {
    exec.mockRejectedValueOnce(
      Object.assign(
        new Error('GraphQL partial error'),
        response(fields, [{ path: ['repository', 'pullRequest', 'stack'], message: 'Unavailable' }])
      )
    )
    await expect(
      getPRByNumber(repository, 42, options, 'local:host', undefined, { includeStackSummary: true })
    ).resolves.toMatchObject({
      title: fields.title,
      stackMetadataChecked: false
    })
    expect(exec).toHaveBeenCalledTimes(1)
  })

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
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0].slice(0, 2)).toEqual(['pr', 'view'])
  })

  it.each(['github.corp.example', undefined])(
    'keeps the existing read for host %s',
    async (host) => {
      exec.mockResolvedValueOnce({ stdout: JSON.stringify({ ...fields, statusCheckRollup: [] }) })
      await expect(
        getPRByNumber({ ...repository, host }, 42, options, 'local:host', undefined, {
          includeStackSummary: true
        })
      ).resolves.toMatchObject({ number: 42 })
      expect(exec).toHaveBeenCalledTimes(1)
      expect(exec.mock.calls[0][0].slice(0, 2)).toEqual(['pr', 'view'])
    }
  )

  it.each([
    { ghAccount: { host: 'github.com', user: 'reviewer' }, env: { GH_TOKEN: 'fixture' } },
    { wslDistro: 'Ubuntu' },
    {}
  ])('retains the caller execution and account options: %j', async (execution) => {
    exec.mockResolvedValueOnce(
      response({
        ...fields,
        headRepository: null,
        headRepositoryOwner: null,
        headRefOid: null,
        commits: { nodes: [{ commit: { oid: fields.headRefOid, statusCheckRollup: null } }] }
      })
    )
    await expect(
      readPullRequestSidebarQuery(repository, 42, { ...options, ...execution })
    ).resolves.toMatchObject({
      headRefOid: undefined,
      headRepository: null,
      statusCheckRollup: [],
      stackMetadataChecked: true
    })
    expect(exec.mock.calls[0][1]).toEqual({ ...options, ...execution, host: 'github.com' })
  })
})
