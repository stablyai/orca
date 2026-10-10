import { describe, expect, it, vi } from 'vitest'
import { terminateDescendantSnapshotWithVerdict } from '../pty-descendant-exit-verification'
import {
  collectDescendantRows,
  type DescendantSnapshot,
  type ProcessTableRow
} from '../pty-descendant-termination'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

const ROOT_PID = 500
const ORCA_PGID = 400
const ROOT_STARTED_AT = 'Thu Sep 3 18:04:50 2026'
/** The second both close-time walks land in. */
const WALK_SECOND = 'Thu Sep 3 18:05:04 2026'
const WALK_MS = Date.parse(WALK_SECOND)
const EARLIER_SECOND = 'Thu Sep 3 18:05:03 2026'

/** The measured split: `s20` at :03.946 died, `s21` at :04.042 leaked. */
const EARLIER_BORN = [700, 701, 702]
const WALK_SECOND_BORN = [721, 722, 723, 724]

type Cohort = { pids: number[]; startedAt: string }

const LIVE_TREE: Cohort[] = [
  { pids: EARLIER_BORN, startedAt: EARLIER_SECOND },
  { pids: WALK_SECOND_BORN, startedAt: WALK_SECOND }
]

function rowsFor(cohorts: Cohort[]): ProcessTableRow[] {
  return [
    { pid: ROOT_PID, ppid: 1, pgid: ORCA_PGID, startedAt: ROOT_STARTED_AT },
    ...cohorts.flatMap((cohort) =>
      cohort.pids.map((pid) => ({
        pid,
        ppid: ROOT_PID,
        pgid: ORCA_PGID,
        startedAt: cohort.startedAt
      }))
    )
  ]
}

/** A real ppid walk from the root, exactly as production captures one. */
function walk(capturedAtMs: number, cohorts: Cohort[] = LIVE_TREE): DescendantSnapshot {
  return collectDescendantRows(ROOT_PID, rowsFor(cohorts), capturedAtMs)
}

function killedPids(calls: [number, NodeJS.Signals][]): number[] {
  return calls.flatMap(([pid, signal]) => (signal === 'SIGKILL' ? [pid] : [])).sort((a, b) => a - b)
}

function signalledPids(calls: [number, NodeJS.Signals][]): number[] {
  return calls.flatMap(([pid, signal]) => (signal === 'SIGTERM' ? [pid] : [])).sort((a, b) => a - b)
}

/**
 * Drives the real reaper and the real verifier against a process table where
 * every descendant traps SIGTERM, so only a forced sweep can end them. The root
 * is alive for both walks and gone by the sweep, which is the measured teardown.
 */
async function sweep(
  captures: DescendantSnapshot[],
  liveTree: Cohort[] = LIVE_TREE
): Promise<[number, NodeJS.Signals][]> {
  const calls: [number, NodeJS.Signals][] = []
  const captureDescendants = vi.fn()
  for (const capture of captures) {
    captureDescendants.mockResolvedValueOnce(capture)
  }
  const tree = createClaudeChildTreeReaper(
    { pid: ROOT_PID, kill: vi.fn(() => true) },
    {
      platform: 'linux',
      exited: () => false,
      captureDescendants,
      terminateDescendants: (snapshot) =>
        terminateDescendantSnapshotWithVerdict(snapshot, {
          requireIdentityBeforeSignal: true,
          graceMs: 0,
          verifyMs: 120,
          sendSignal: (pid, signal) => calls.push([pid, signal]),
          readTable: async () => ({ rows: rowsFor(liveTree), capturedAtMs: Date.now() })
        })
    }
  )
  // The close ladder's shape: arm, then re-walk the live root at the boundary.
  await tree.capture()
  await tree.refresh?.()
  await tree.reap()
  return calls
}

describe('Claude descendant forced-sweep fence', () => {
  it('escalates a descendant forked in the same second as both close walks', async () => {
    // Both walks land inside second :04, one ps duration apart, and the root is
    // gone before a third could run. A descendant born at :04.042 is no less
    // ours than its sibling born 96ms earlier at :03.946.
    const calls = await sweep([walk(WALK_MS + 42), walk(WALK_MS + 140)])

    expect(signalledPids(calls)).toEqual([...EARLIER_BORN, ...WALK_SECOND_BORN])
    expect(killedPids(calls)).toEqual([...EARLIER_BORN, ...WALK_SECOND_BORN])
  })

  it('still escalates descendants born before the walk that first saw them', async () => {
    const onlyEarlier = [{ pids: EARLIER_BORN, startedAt: EARLIER_SECOND }]
    const calls = await sweep([walk(WALK_MS + 42, onlyEarlier)], onlyEarlier)

    expect(killedPids(calls)).toEqual(EARLIER_BORN)
  })

  it('withholds the sweep from a row no walk re-derived, on its start second alone', async () => {
    // 900 was seen once, in its own birth second, and the refresh did not find
    // it. The merge retains the row, but nothing re-proved it belongs to us, so
    // the second-resolution fence is all there is and it still says no.
    const retained = { pids: [900], startedAt: WALK_SECOND }
    const firstWalk = walk(WALK_MS + 42, [...LIVE_TREE, retained])
    const refresh = walk(WALK_MS + 140)

    const calls = await sweep([firstWalk, refresh], [...LIVE_TREE, retained])

    expect(signalledPids(calls)).toEqual([...EARLIER_BORN, ...WALK_SECOND_BORN, 900])
    expect(killedPids(calls)).toEqual([...EARLIER_BORN, ...WALK_SECOND_BORN])
  })
})
