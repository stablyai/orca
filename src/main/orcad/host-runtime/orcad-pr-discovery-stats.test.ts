import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import { runHostedPRRead } from '../../github/pull-requests/refresh/pr-refresh-coordinator'
import {
  makeCandidate,
  makePR
} from '../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
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
  const candidate = makeCandidate({ repoPath })
  const read = () =>
    runHostedPRRead(candidate, async () => ({ kind: 'found', pr: makePR(), fetchedAt: 1 }))
  try {
    await runHostedPRRead(
      makeCandidate({ repoId: 'unregistered', repoPath: join(directory, 'unregistered') }),
      async () => ({ kind: 'found', pr: makePR(), fetchedAt: 1 })
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
      pr: makePR({ url: 'https://github.com/acme/repo/pull/13', number: 13 }),
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
