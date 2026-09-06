import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestLookupData } from './pull-request-lookup-data'
import { hydrateUnstablePRCheckRollup } from './unstable-pr-check-rollup'

const getPRChecksWithExistingOperationPermitMock = vi.hoisted(() => vi.fn())

vi.mock('./../check/get-pr-checks', () => ({
  getPRChecksWithExistingOperationPermit: getPRChecksWithExistingOperationPermitMock
}))

function createPullRequest(overrides: Partial<PullRequestLookupData> = {}): PullRequestLookupData {
  return {
    number: 42,
    title: 'Manual approval',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/42',
    statusCheckRollup: [],
    updatedAt: '2026-08-26T10:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    headRefOid: 'head-oid',
    ...overrides
  }
}

const lookupArgs = {
  repoPath: '/repo-root',
  dataRepo: { host: 'github.com', owner: 'acme', repo: 'widgets' },
  connectionId: null,
  localGitOptions: {}
}

describe('hydrateUnstablePRCheckRollup', () => {
  beforeEach(() => {
    getPRChecksWithExistingOperationPermitMock.mockReset()
  })

  it('reuses the PR lookup operation permit for the detailed request', async () => {
    getPRChecksWithExistingOperationPermitMock.mockResolvedValue([
      {
        name: 'GitHub Actions',
        status: 'completed',
        conclusion: 'action_required',
        url: null
      }
    ])

    await hydrateUnstablePRCheckRollup(createPullRequest(), lookupArgs)

    expect(getPRChecksWithExistingOperationPermitMock).toHaveBeenCalledWith(
      '/repo-root',
      42,
      'head-oid',
      lookupArgs.dataRepo,
      null,
      {}
    )
  })

  it('loads suite-only checks for an open unstable PR with an empty rollup', async () => {
    const loadChecks = vi.fn().mockResolvedValue([
      {
        name: 'GitHub Actions',
        status: 'completed',
        conclusion: 'action_required',
        url: 'https://github.com/acme/widgets/commit/head-oid/checks'
      }
    ])

    const result = await hydrateUnstablePRCheckRollup(createPullRequest(), lookupArgs, loadChecks)

    expect(loadChecks).toHaveBeenCalledOnce()
    expect(result.statusCheckRollup).toEqual([
      expect.objectContaining({ conclusion: 'action_required' })
    ])
  })

  it('replaces a partial passing rollup with detailed checks for an open unstable PR', async () => {
    const loadChecks = vi.fn().mockResolvedValue([
      {
        name: 'track-community-pr',
        status: 'completed',
        conclusion: 'success',
        url: null
      },
      {
        name: 'GitHub Actions',
        status: 'completed',
        conclusion: 'action_required',
        url: null
      }
    ])

    const result = await hydrateUnstablePRCheckRollup(
      createPullRequest({
        statusCheckRollup: [
          { name: 'track-community-pr', status: 'COMPLETED', conclusion: 'SUCCESS' }
        ]
      }),
      lookupArgs,
      loadChecks
    )

    expect(loadChecks).toHaveBeenCalledOnce()
    expect(result.statusCheckRollup).toEqual([
      expect.objectContaining({ conclusion: 'success' }),
      expect.objectContaining({ conclusion: 'action_required' })
    ])
  })

  it('replaces a partial passing rollup when GitHub reports an unknown merge state', async () => {
    const loadChecks = vi.fn().mockResolvedValue([
      {
        name: 'track-community-pr',
        status: 'completed',
        conclusion: 'success',
        url: null
      },
      {
        name: 'GitHub Actions',
        status: 'completed',
        conclusion: 'action_required',
        url: null
      }
    ])

    const result = await hydrateUnstablePRCheckRollup(
      createPullRequest({
        mergeStateStatus: 'UNKNOWN',
        statusCheckRollup: [
          { name: 'track-community-pr', status: 'COMPLETED', conclusion: 'SUCCESS' }
        ]
      }),
      lookupArgs,
      loadChecks
    )

    expect(loadChecks).toHaveBeenCalledOnce()
    expect(result.statusCheckRollup).toEqual([
      expect.objectContaining({ conclusion: 'success' }),
      expect.objectContaining({ conclusion: 'action_required' })
    ])
  })

  it.each(['UNSTABLE', 'UNKNOWN'])(
    'loads a suite-only blocker while another visible check is pending for %s',
    async (mergeStateStatus) => {
      const pendingCheck = { name: 'build', status: 'IN_PROGRESS', conclusion: null }
      const loadChecks = vi.fn().mockResolvedValue([
        pendingCheck,
        {
          name: 'GitHub Actions',
          status: 'completed',
          conclusion: 'action_required',
          url: null
        }
      ])

      const result = await hydrateUnstablePRCheckRollup(
        createPullRequest({ mergeStateStatus, statusCheckRollup: [pendingCheck] }),
        lookupArgs,
        loadChecks
      )

      expect(loadChecks).toHaveBeenCalledOnce()
      expect(result.statusCheckRollup).toEqual([
        pendingCheck,
        expect.objectContaining({ conclusion: 'action_required' })
      ])
    }
  )

  it.each([
    ['a failing rollup', { statusCheckRollup: [{ conclusion: 'failure' }] }],
    ['an action-required rollup', { statusCheckRollup: [{ conclusion: 'action_required' }] }],
    [
      'an unknown merge state with a failing rollup',
      { mergeStateStatus: 'UNKNOWN', statusCheckRollup: [{ conclusion: 'failure' }] }
    ],
    [
      'an unknown merge state with an action-required rollup',
      { mergeStateStatus: 'UNKNOWN', statusCheckRollup: [{ conclusion: 'action_required' }] }
    ],
    ['a stable merge state', { mergeStateStatus: 'CLEAN' }],
    ['a draft PR', { isDraft: true }],
    ['a closed PR', { state: 'CLOSED' }],
    ['a merged PR', { state: 'MERGED', mergeStateStatus: 'UNKNOWN' }]
  ])('does not load detailed checks for %s', async (_label, overrides) => {
    const loadChecks = vi.fn()

    const result = await hydrateUnstablePRCheckRollup(
      createPullRequest(overrides),
      lookupArgs,
      loadChecks
    )

    expect(loadChecks).not.toHaveBeenCalled()
    expect(result).toEqual(createPullRequest(overrides))
  })

  it('keeps a partial passing rollup neutral when detailed checks are empty', async () => {
    const data = createPullRequest({
      statusCheckRollup: [{ name: 'track-community-pr', conclusion: 'SUCCESS' }]
    })
    const loadChecks = vi.fn().mockResolvedValue([])

    const result = await hydrateUnstablePRCheckRollup(data, lookupArgs, loadChecks)

    expect(loadChecks).toHaveBeenCalledOnce()
    expect(result.statusCheckRollup).toEqual([])
    expect(data.statusCheckRollup).toHaveLength(1)
  })

  it('keeps a partial passing rollup neutral when detailed checks cannot be loaded', async () => {
    const error = new Error('rate limited')
    const loadChecks = vi.fn().mockRejectedValue(error)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = createPullRequest({
      statusCheckRollup: [{ name: 'track-community-pr', conclusion: 'SUCCESS' }]
    })

    const result = await hydrateUnstablePRCheckRollup(data, lookupArgs, loadChecks)

    expect(result.statusCheckRollup).toEqual([])
    expect(warn).toHaveBeenCalledWith('Unable to hydrate incomplete PR checks:', error)
    warn.mockRestore()
  })

  it('keeps a visible pending check when detailed checks cannot be loaded', async () => {
    const error = new Error('rate limited')
    const loadChecks = vi.fn().mockRejectedValue(error)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = createPullRequest({
      statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS', conclusion: null }]
    })

    const result = await hydrateUnstablePRCheckRollup(data, lookupArgs, loadChecks)

    expect(result).toBe(data)
    expect(warn).toHaveBeenCalledWith('Unable to hydrate incomplete PR checks:', error)
    warn.mockRestore()
  })
})
