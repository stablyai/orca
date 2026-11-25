import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import { runHostedPRRead } from '../../github/pull-requests/refresh/pr-refresh-coordinator'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { startOrcadStats } from './orcad-stats'

it('counts background PR discoveries once on a headless host without opening a PR screen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr-discovery-stats-'))
  const cleanups: BackendServiceCleanup[] = []
  const repoPath = join(directory, 'repo')
  const stats = startOrcadStats(
    directory,
    { subscribeEnrichedStatus: () => () => {}, subscribePaneStatusClear: () => () => {} },
    (cleanup) => cleanups.push(cleanup),
    () => [{ id: 'repo-1', path: repoPath }]
  )
  const candidate: GitHubPRRefreshCandidate = {
    cacheKey: 'repo::feature/test',
    repoPath,
    branch: 'feature/test',
    repoKind: 'git',
    repoId: 'repo-1',
    worktreeId: 'wt-1'
  }
  const pr: PRInfo = {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/12',
    checksStatus: 'pending',
    updatedAt: '2026-05-12T00:00:00Z',
    mergeable: 'MERGEABLE',
    headSha: 'head-sha'
  }
  const read = () => runHostedPRRead(candidate, async () => ({ kind: 'found', pr, fetchedAt: 1 }))
  try {
    await runHostedPRRead(
      { ...candidate, repoId: 'unregistered', repoPath: join(directory, 'unregistered') },
      async () => ({ kind: 'found', pr, fetchedAt: 1 })
    )
    await runHostedPRRead(candidate, async () => ({ kind: 'no-pr', fetchedAt: 1 }))
    expect(stats.getSummary().totalPRsCreated).toBe(0)
    await read()
    await read()
    expect(stats.getSummary().totalPRsCreated).toBe(1)
    for (const cleanup of cleanups.toReversed()) {
      await cleanup({ failed: false })
    }
    await runHostedPRRead(candidate, async () => ({
      kind: 'found',
      pr: { ...pr, url: 'https://github.com/acme/repo/pull/13', number: 13 },
      fetchedAt: 2
    }))
    expect(stats.getSummary().totalPRsCreated).toBe(1)
  } finally {
    for (const cleanup of cleanups.toReversed()) {
      await cleanup({ failed: false })
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
