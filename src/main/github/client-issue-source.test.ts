/* eslint-disable max-lines -- Why: the issue-source test suite covers the
heuristic split (#1076), the partial-failure envelope (feature 1), and the
three-state preference matrix (feature 2) as one surface so a regression in
any of them blocks the same merge gate. */
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

import { countWorkItems, getWorkItem, listWorkItems, _resetOwnerRepoCache } from './client'

describe('GitHub issue source split', () => {
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
    // Why: default the preference-aware resolver to 'auto' semantics so the
    // pre-existing test cases (which don't think about preference at all)
    // still pass. `listWorkItems` now calls `resolveIssueSource` instead of
    // `getIssueOwnerRepo` directly — we delegate back to the single-call
    // mock to preserve the one-fetch-per-test invariant each test sets up.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
    // Default the upstream-candidate lookup to null so existing tests that
    // only mock `getIssueOwnerRepo` + `getOwnerRepo` don't need to think
    // about it. Tests that care set it explicitly.
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    _resetOwnerRepoCache()
  })

  it('uses upstream for issues and origin for PRs in mixed recent results', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 923,
            title: 'Use upstream issues',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/issues/923',
            labels: [],
            updated_at: '2026-04-01T00:00:00Z',
            user: { login: 'octocat' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Fork PR',
            state: 'open',
            html_url: 'https://github.com/fork/orca/pull/42',
            labels: [],
            updated_at: '2026-03-31T00:00:00Z',
            user: { login: 'octocat' },
            draft: false,
            head: { ref: 'feature' },
            base: { ref: 'main' }
          }
        ])
      })

    await listWorkItems('/repo-root', 10)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--cache',
        '120s',
        'repos/stablyai/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--cache',
        '120s',
        'repos/fork/orca/pulls?per_page=10&state=open&sort=updated&direction=desc'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('lists SSH repo work items with explicit owner/repo and no local cwd', async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: '[]'
    })

    await listWorkItems('/home/jinwoo/orca', 10, undefined, undefined, 'auto', 'openclaw-2')

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/home/jinwoo/orca', 'auto', 'openclaw-2')
    expect(getOwnerRepoMock).toHaveBeenCalledWith('/home/jinwoo/orca', 'openclaw-2')
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--cache',
        '120s',
        'repos/stablyai/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
      ],
      {}
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--cache',
        '120s',
        'repos/fork/orca/pulls?per_page=10&state=open&sort=updated&direction=desc'
      ],
      {}
    )
  })

  it('uses upstream for issue-only queries and origin for PR-only queries', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:issue')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--repo', 'stablyai/orca']),
      { cwd: '/repo-root' }
    )

    ghExecFileAsyncMock.mockClear()
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:pr')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--repo', 'fork/orca']),
      { cwd: '/repo-root' }
    )
  })

  it('counts default work items across upstream issues and origin PRs', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '7\n' })
      .mockResolvedValueOnce({ stdout: '5\n' })

    const count = await countWorkItems('/repo-root')

    expect(count).toBe(12)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:stablyai/orca is:issue is:open')}&per_page=1`,
        '--jq',
        '.total_count'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:fork/orca is:pull-request is:open')}&per_page=1`,
        '--jq',
        '.total_count'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('typed PR lookup does not fetch an upstream issue with the same number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        html_url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updated_at: '2026-04-02T00:00:00Z',
        user: { login: 'octocat' },
        draft: false,
        head: { ref: 'feature' },
        base: { ref: 'main' }
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr')

    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', 'repos/fork/orca/pulls/42'], {
      cwd: '/repo-root'
    })
    expect(item?.type).toBe('pr')
  })

  it('raw number lookup tries upstream issue before origin PR', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    // Why: simulate a real gh 404 (the only error type that should fall through).
    // Non-404 errors re-throw so transient upstream failures don't misroute to an
    // unrelated origin PR with the same number.
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        html_url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updated_at: '2026-04-02T00:00:00Z',
        user: { login: 'octocat' },
        draft: false
      })
    })

    const item = await getWorkItem('/repo-root', 42)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/stablyai/orca/issues/42'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/fork/orca/pulls/42'], {
      cwd: '/repo-root'
    })
    expect(item?.type).toBe('pr')
  })

  it('surfaces a 403 from upstream issues through the listWorkItems envelope', async () => {
    // Why: parent design doc §3 / acceptance criterion 2 — the IPC envelope
    // must carry a classified error for the failing side so the renderer can
    // swap the empty-state for a retryable banner. `sources` must stay
    // populated so the banner copy can name the repo that failed.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 403: Resource not accessible by integration'))
      .mockResolvedValueOnce({ stdout: '[]' })

    const result = await listWorkItems('/repo-root', 10)

    expect(result.items).toEqual([])
    expect(result.sources).toMatchObject({
      issues: { owner: 'stablyai', repo: 'orca' },
      prs: { owner: 'fork', repo: 'orca' }
    })
    expect(result.errors?.issues?.type).toBe('permission_denied')
  })

  it('returns partial results when upstream issues fail but origin PRs succeed', async () => {
    // Why: parent design doc §2 partial-failure rule — a failing source must
    // not zero out the succeeding source. The UI renders origin PRs with a
    // banner above the list, not an empty state. Ensures the IPC shape
    // carries both the successful items and the error for the failing side.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 403: Resource not accessible by integration'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Fork PR',
            state: 'open',
            html_url: 'https://github.com/fork/orca/pull/42',
            labels: [],
            updated_at: '2026-03-31T00:00:00Z',
            user: { login: 'octocat' },
            draft: false,
            head: { ref: 'feature' },
            base: { ref: 'main' }
          }
        ])
      })

    const result = await listWorkItems('/repo-root', 10)

    expect(result.items.map((i) => i.id)).toEqual(['pr:42'])
    expect(result.errors?.issues?.type).toBe('permission_denied')
  })

  it('raw number lookup does not fall through on transient upstream errors', async () => {
    // Why: with issue source split, a non-404 upstream failure must not silently
    // route to origin's PR #N — that would return an unrelated item.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 500: server error'))

    const item = await getWorkItem('/repo-root', 42)

    expect(item).toBeNull()
    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  describe('per-repo issue-source preference', () => {
    // Why: 3 preference states × 2 remote-topology states = 6 cases per the
    // design doc §9. These tests isolate `listWorkItems` against a mocked
    // `resolveIssueSource` to verify the preference is threaded all the way
    // to the gh call and that `fellBack` propagates into the envelope.

    it("preference='auto' + upstream exists → queries upstream", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'stablyai', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'auto')

      expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'auto', undefined)
      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        [
          'api',
          '--cache',
          '120s',
          'repos/stablyai/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
        ],
        { cwd: '/repo-root' }
      )
      expect(result.issueSourceFellBack).toBeUndefined()
    })

    it("preference='auto' + no upstream → queries origin", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'solo', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'solo', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      await listWorkItems('/repo-root', 10, undefined, undefined, 'auto')

      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        [
          'api',
          '--cache',
          '120s',
          'repos/solo/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
        ],
        { cwd: '/repo-root' }
      )
    })

    it("preference='upstream' + upstream exists → queries upstream", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'stablyai', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'upstream')

      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([
          'repos/stablyai/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
        ]),
        { cwd: '/repo-root' }
      )
      expect(result.issueSourceFellBack).toBeUndefined()
    })

    it("preference='upstream' + no upstream → falls back to origin with fellBack=true", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'solo', repo: 'orca' },
        fellBack: true
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'solo', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'upstream')

      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([
          'repos/solo/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
        ]),
        { cwd: '/repo-root' }
      )
      expect(result.issueSourceFellBack).toBe(true)
    })

    it("preference='origin' + upstream exists → queries origin (not upstream)", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'fork', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      await listWorkItems('/repo-root', 10, undefined, undefined, 'origin')

      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([
          'repos/fork/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
        ]),
        { cwd: '/repo-root' }
      )
    })

    it("preference='origin' + no upstream → queries origin", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'solo', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'solo', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      await listWorkItems('/repo-root', 10, undefined, undefined, 'origin')

      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([
          'repos/solo/orca/issues?per_page=10&state=open&sort=updated&direction=desc'
        ]),
        { cwd: '/repo-root' }
      )
    })

    it('surfaces upstreamCandidate in sources regardless of effective preference', async () => {
      // Why: the renderer selector needs to keep rendering after the user picks
      // 'origin'. That requires the envelope to carry the raw upstream even
      // when `sources.issues` has collapsed onto origin.
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'fork', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'origin')

      expect(result.sources).toEqual({
        issues: { owner: 'fork', repo: 'orca' },
        prs: { owner: 'fork', repo: 'orca' },
        upstreamCandidate: { owner: 'stablyai', repo: 'orca' }
      })
    })
  })
})
