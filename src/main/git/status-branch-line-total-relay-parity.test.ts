/**
 * Main and relay must publish the same `branchLineTotal` for the same fixture
 * repo. Both call sites
 * share `src/shared/git-branch-line-total.ts`; this is the test that catches one
 * of them wiring it up differently — different flags, a different untracked
 * source, a different completeness gate.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getStatus } from './status'
import type { GitExec } from '../../relay/git-handler-ops'
import { getStatusOp } from '../../relay/git-handler-status-ops'
import type { RelayGitStreamExec } from '../../relay/git-stdout-stream'
import { invalidateGitBranchLineTotalInFlight } from '../../shared/git-branch-line-total'
import { clearGitStatusLineStatsCache } from '../../shared/git-status-line-stats-cache'

const execFileAsync = promisify(execFile)

// Fork point → working tree for the fixture below:
//   tracked.txt  +2  (branch commit only)
//   partial.txt  +1  (staged +2 then one of those lines removed unstaged)
//   flip.txt      0  (added in the branch commit, removed again in the worktree)
//   moved.txt     0  (pure rename)
//   fresh.txt    +3  (untracked)
// No fixture path here looks like test or generated code, so it is all source.
const EXPECTED_TOTAL = {
  added: 6,
  removed: 0,
  test: { added: 0, removed: 0 },
  generated: { added: 0, removed: 0 }
}
// Summing the per-area status rows instead would give this — the wrong answer
// the shared module exists to avoid.
const AREA_ROW_SUM = { added: 5, removed: 2 }

const relayGit: GitExec = async (args, cwd, opts) => {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeout ? { timeout: opts.timeout } : {})
  })
  return { stdout, stderr }
}

const relayStreamGit: RelayGitStreamExec = async (args, cwd, options) => {
  const { stdout } = await relayGit(args, cwd, {
    disableOptionalLocks: options.disableOptionalLocks,
    signal: options.signal
  })
  return { stoppedEarly: options.onStdout(stdout) === true }
}

function runFixtureGit(repo: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=test@test.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgSign=false',
      ...args
    ],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** Returns the merge-base OID the chip is measured against. */
async function seedParityFixture(repo: string): Promise<string> {
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' })
  await writeFile(path.join(repo, 'tracked.txt'), 'a\nb\n')
  await writeFile(path.join(repo, 'partial.txt'), 'one\ntwo\nthree\n')
  await writeFile(path.join(repo, 'renamed.txt'), 'stable\n')
  await writeFile(path.join(repo, 'flip.txt'), 'p\n')
  runFixtureGit(repo, ['add', '.'])
  runFixtureGit(repo, ['commit', '-m', 'base'])
  const mergeBase = runFixtureGit(repo, ['rev-parse', 'HEAD'])

  runFixtureGit(repo, ['checkout', '-q', '-b', 'feature'])
  await writeFile(path.join(repo, 'tracked.txt'), 'a\nb\nc\nd\n')
  await writeFile(path.join(repo, 'flip.txt'), 'p\nq\n')
  runFixtureGit(repo, ['add', '-A'])
  runFixtureGit(repo, ['commit', '-m', 'branch commit'])

  runFixtureGit(repo, ['mv', 'renamed.txt', 'moved.txt'])
  // Staged and unstaged hunks land on the same added lines, so an area sum
  // double-counts them.
  await writeFile(path.join(repo, 'partial.txt'), 'one\ntwo\nthree\nfoo\nbaz\n')
  runFixtureGit(repo, ['add', 'partial.txt'])
  await writeFile(path.join(repo, 'partial.txt'), 'one\ntwo\nthree\nfoo\n')
  // The branch commit's line, taken back out in the worktree: net zero.
  await writeFile(path.join(repo, 'flip.txt'), 'p\n')
  await writeFile(path.join(repo, 'fresh.txt'), 'n1\nn2\nn3\n')
  return mergeBase
}

function sumAreaRows(entries: readonly { added?: number; removed?: number }[]): {
  added: number
  removed: number
} {
  let added = 0
  let removed = 0
  for (const entry of entries) {
    added += entry.added ?? 0
    removed += entry.removed ?? 0
  }
  return { added, removed }
}

describe('branch line total parity between main and relay', () => {
  let repo: string

  beforeEach(async () => {
    clearGitStatusLineStatsCache()
    invalidateGitBranchLineTotalInFlight()
    repo = await mkdtemp(path.join(tmpdir(), 'branch-line-total-parity-'))
  })

  afterEach(async () => {
    clearGitStatusLineStatsCache()
    invalidateGitBranchLineTotalInFlight()
    await rm(repo, { recursive: true, force: true })
  })

  it('produces identical totals for the same fixture repo', async () => {
    const mergeBase = await seedParityFixture(repo)

    const mainStatus = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    clearGitStatusLineStatsCache()
    const relayStatus = await getStatusOp(relayGit, relayStreamGit, {
      worktreePath: repo,
      branchLineTotalMergeBase: mergeBase
    })

    expect(mainStatus.branchLineTotal).toEqual({ ...EXPECTED_TOTAL, mergeBase })
    expect(relayStatus.branchLineTotal).toEqual(mainStatus.branchLineTotal)
    // Both sides model the same worktree, so a parity pass on a mismatched
    // entry list would be meaningless.
    expect(relayStatus.entries.map((entry) => entry.path).sort()).toEqual(
      mainStatus.entries.map((entry) => entry.path).sort()
    )
  })

  it('agrees on a number no per-area row sum could produce', async () => {
    const mergeBase = await seedParityFixture(repo)

    const mainStatus = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    clearGitStatusLineStatsCache()
    const relayStatus = await getStatusOp(relayGit, relayStreamGit, {
      worktreePath: repo,
      branchLineTotalMergeBase: mergeBase
    })

    expect(sumAreaRows(mainStatus.entries)).toEqual(AREA_ROW_SUM)
    expect(sumAreaRows(relayStatus.entries as { added?: number; removed?: number }[])).toEqual(
      AREA_ROW_SUM
    )
    expect(mainStatus.branchLineTotal).not.toMatchObject(AREA_ROW_SUM)
    expect(relayStatus.branchLineTotal).toEqual(mainStatus.branchLineTotal)
  })

  it('omits the total on both sides when no merge base is requested', async () => {
    await seedParityFixture(repo)

    const mainStatus = await getStatus(repo)
    clearGitStatusLineStatsCache()
    const relayStatus = await getStatusOp(relayGit, relayStreamGit, { worktreePath: repo })

    expect(Object.hasOwn(mainStatus, 'branchLineTotal')).toBe(false)
    expect(Object.hasOwn(relayStatus, 'branchLineTotal')).toBe(false)
  })
})
