import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sidebar: vi.fn(), checks: vi.fn() }))
vi.mock('./pull-request-sidebar-query', () => ({ readPullRequestSidebarQuery: mocks.sidebar }))
vi.mock('../check/complete-pr-check-observation', () => ({
  readCompletePRCheckObservation: mocks.checks
}))

import {
  readSharedPRCheckObservation,
  readSharedPullRequestSidebarQuery
} from './shared-pr-provider-reads'

const REPO = { owner: 'acme', repo: 'orca' }
const SCOPE = 'local-runtime'

describe('shared PR provider reads', () => {
  beforeEach(() => {
    mocks.sidebar.mockReset()
    mocks.checks.mockReset()
  })

  it('sends one request per PR for every checkout of one account, and none across accounts', async () => {
    mocks.sidebar.mockImplementation(async () => ({ number: 12 }))
    const reads = [
      readSharedPullRequestSidebarQuery(REPO, 12, { cwd: '/repo' }, SCOPE),
      readSharedPullRequestSidebarQuery(
        { owner: 'ACME', repo: 'orca' },
        12,
        { cwd: '/repo-wt' },
        SCOPE
      ),
      readSharedPullRequestSidebarQuery(
        REPO,
        12,
        { cwd: '/repo', ghAccount: { host: 'github.com', user: 'other' } },
        SCOPE
      ),
      readSharedPullRequestSidebarQuery(REPO, 12, { cwd: '/repo' }, 'wsl:Ubuntu')
    ]
    expect(mocks.sidebar).toHaveBeenCalledTimes(3)
    const [first, second] = await Promise.all(reads)
    expect(first).toBe(second)
  })

  it('shares a check read only for the same head', async () => {
    mocks.checks.mockImplementation(() => new Promise(() => {}))
    void readSharedPRCheckObservation(REPO, 12, 'aaa', { cwd: '/repo' }, SCOPE)
    void readSharedPRCheckObservation(REPO, 12, 'aaa', { cwd: '/repo-wt' }, SCOPE)
    void readSharedPRCheckObservation(REPO, 12, 'bbb', { cwd: '/repo' }, SCOPE)
    expect(mocks.checks).toHaveBeenCalledTimes(2)
  })
})
