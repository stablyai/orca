import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { readPRRefreshOutcome } from './pr-refresh-coordinator'
import { readWorkspacePR, type WorkspacePRReadWorktree } from './workspace-pr-read'

vi.mock('./pr-refresh-coordinator', () => ({ readPRRefreshOutcome: vi.fn() }))
const read = vi.mocked(readPRRefreshOutcome)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these fields.
const repo = { id: 'repo-1', path: '/repos/orca', kind: 'git' } as Repo
const worktree: WorkspacePRReadWorktree = {
  id: 'repo-1::/repos/orca-wt',
  branch: 'refs/heads/fix-list',
  head: 'abc123',
  linkedPR: null
}
const cacheKey = 'repo-1::fix-list'
const NOW = Date.parse('2026-11-23T12:00:00Z')

function pr(state: PRInfo['state']): PRInfo {
  return {
    number: 42,
    title: 'Fix the list',
    state,
    url: 'https://github.com/o/r/pull/42',
    checksStatus: 'success',
    checksReadComplete: true,
    updatedAt: '2026-11-23T00:00:00Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123'
  }
}

function storeWith(data: PRInfo, ageMs: number) {
  return {
    getGitHubCache: () => ({
      pr: { [cacheKey]: { data, fetchedAt: NOW - ageMs } },
      issue: {}
    })
  }
}

beforeEach(() => {
  read.mockReset()
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => vi.useRealTimers())

describe('a workspace PR read outside its row', () => {
  it('reads a stale open PR again and shows the merge, by number once the branch is gone', async () => {
    read.mockResolvedValue({ kind: 'found', pr: pr('merged'), fetchedAt: NOW })
    const shown = await readWorkspacePR(storeWith(pr('open'), 60 * 60_000), worktree, repo, 1_000)
    expect(shown?.state).toBe('merged')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0][0]).toMatchObject({
      cacheKey,
      branch: 'fix-list',
      worktreeId: worktree.id,
      fallbackPRNumber: 42
    })
  })

  it('keeps the cached PR when the read does not land in time', async () => {
    read.mockResolvedValue(null)
    const shown = await readWorkspacePR(storeWith(pr('open'), 60 * 60_000), worktree, repo, 1_000)
    expect(shown?.state).toBe('open')
  })

  it('never reads a fresh open PR or a merged one with final checks again', async () => {
    await readWorkspacePR(storeWith(pr('open'), 5_000), worktree, repo, 1_000)
    await readWorkspacePR(storeWith(pr('merged'), 24 * 60 * 60_000), worktree, repo, 1_000)
    expect(read).not.toHaveBeenCalled()
  })
})
