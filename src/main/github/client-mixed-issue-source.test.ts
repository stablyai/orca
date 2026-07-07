import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhUtils from './gh-utils'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolveIssueSourceMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    execFileAsync: execFileAsyncMock,
    ghExecFileAsync: ghExecFileAsyncMock,
    getOwnerRepo: getOwnerRepoMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock,
    _resetOwnerRepoCache: vi.fn()
  }
})

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import { listWorkItems, _resetOwnerRepoCache } from './client'

const ORIGIN = { owner: 'fork', repo: 'orca' }
const UPSTREAM = { owner: 'stablyai', repo: 'orca' }

function issueJson(number: number, slug: string, updatedAt: string): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number} of ${slug}`,
    state: 'open',
    html_url: `https://github.com/${slug}/issues/${number}`,
    labels: [],
    updated_at: updatedAt,
    user: { login: 'octocat' }
  }
}

describe('mixed issue source list merge', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    resolveIssueSourceMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()

    getOwnerRepoMock.mockResolvedValue(ORIGIN)
    getIssueOwnerRepoMock.mockResolvedValue(UPSTREAM)
    resolveIssueSourceMock.mockImplementation(async (_path: string, preference?: string) => ({
      source: preference === 'origin' ? ORIGIN : UPSTREAM,
      fellBack: false
    }))
    // Why: the origin and upstream passes run in parallel, so responses are
    // keyed by the requested URL instead of call order.
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const url = args.at(-1) ?? ''
      if (url.includes('repos/fork/orca/issues')) {
        return { stdout: JSON.stringify([issueJson(5, 'fork/orca', '2026-03-01T00:00:00Z')]) }
      }
      if (url.includes('repos/stablyai/orca/issues')) {
        return {
          stdout: JSON.stringify([issueJson(5, 'stablyai/orca', '2026-04-01T00:00:00Z')])
        }
      }
      return { stdout: '[]' }
    })
  })

  // Why: origin #5 and upstream #5 are different items — the merge must keep
  // both, with ids that cannot collide on React keys or selection state.
  it('merges origin and upstream items with disambiguated ids and source stamps', async () => {
    getOwnerRepoForRemoteMock.mockResolvedValue(UPSTREAM)

    const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'mixed')

    expect(result.items).toHaveLength(2)
    expect(result.items.map((item) => item.id)).toEqual([
      'issue:5@stablyai/orca',
      'issue:5@fork/orca'
    ])
    expect(result.items[0].sourceRemote).toBe('upstream')
    expect(result.items[0].sourceOwnerRepo).toEqual(UPSTREAM)
    expect(result.items[1].sourceRemote).toBe('origin')
    expect(result.items[1].sourceOwnerRepo).toEqual(ORIGIN)
    // Sorted by updatedAt desc: upstream item (April) before origin item (March).
    expect(result.items[0].updatedAt > result.items[1].updatedAt).toBe(true)
    expect(result.sources.originCandidate).toEqual(ORIGIN)
    expect(result.sources.upstreamCandidate).toEqual(UPSTREAM)
  })

  // Why: a persisted 'mixed' preference on a repo that is not a fork must
  // behave exactly like 'auto' — no stamping, no duplicate fetches.
  it('degrades to a single auto pass when there is no distinct upstream', async () => {
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    getIssueOwnerRepoMock.mockResolvedValue(ORIGIN)
    resolveIssueSourceMock.mockImplementation(async () => ({ source: ORIGIN, fellBack: false }))

    const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'mixed')

    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('issue:5')
    expect(result.items[0].sourceRemote).toBeUndefined()
  })
})
