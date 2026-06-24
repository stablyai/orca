import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb, CoordinatorRunConflictError } from './db'
import type { CoordinatorRun } from './types'
import {
  buildAdoptedTrackWorktrees,
  reconcileCoordinatorRunsOnBoot,
  type ReconcileCoordinatorRunsOnBootDeps
} from './boot-resume'
import type { WorktreeLineage } from '../../../shared/types'

// Why (F3 #14): regression suite for the zombie-director failure. After an app
// restart the in-memory coordinator is gone but its `coordinator_runs.status=
// 'running'` row survives, tripping F1's per-target active-run guard so a fresh
// run for that target is refused while nothing drives the old one. These tests
// pin: (1) an orphaned running run is reconciled to failed AND a fresh run for
// the target then starts; (2) idempotency; (3) finalize-when-done; (4) the
// resume decision; (5) track re-adoption from lineage.

describe('reconcileCoordinatorRunsOnBoot (F3 #14)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('reconciles an orphaned running run to failed and unblocks a fresh run for the target', async () => {
    const d = createDb()
    const targetKey = 'worktree:wt-director'
    const run = d.startCoordinatorRun({
      spec: 'do work',
      coordinatorHandle: 'coordinator-x',
      targetKey
    })
    // Outstanding work: a ready task owned by the run.
    d.createTask({ spec: 'task A', coordinatorRunId: run.id, targetKey })

    // Without the fix the leftover running row blocks a fresh run for the target.
    expect(() =>
      d.startCoordinatorRun({ spec: 'fresh', coordinatorHandle: 'coordinator-y', targetKey })
    ).toThrow(CoordinatorRunConflictError)

    // The boot hook (no resume callback → MUST-only) reconciles the zombie.
    const results = await reconcileCoordinatorRunsOnBoot({ db: d })
    expect(results).toEqual([{ runId: run.id, disposition: 'failed', reason: expect.any(String) }])
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')

    // The guard is now unblocked: a fresh run for the same target starts.
    const fresh = d.startCoordinatorRun({
      spec: 'fresh',
      coordinatorHandle: 'coordinator-y',
      targetKey
    })
    expect(fresh.status).toBe('running')
  })

  it('is idempotent: a second reconcile does not re-act', async () => {
    const d = createDb()
    const targetKey = 'worktree:wt-director'
    const run = d.startCoordinatorRun({ spec: 'do work', coordinatorHandle: 'c', targetKey })
    d.createTask({ spec: 'task A', coordinatorRunId: run.id, targetKey })

    const first = await reconcileCoordinatorRunsOnBoot({ db: d })
    expect(first).toHaveLength(1)
    const second = await reconcileCoordinatorRunsOnBoot({ db: d })
    expect(second).toHaveLength(0)
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('finalizes a running run whose tasks are all completed as completed (not a zombie)', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'done', coordinatorHandle: 'c' })
    const task = d.createTask({ spec: 'task A', coordinatorRunId: run.id })
    d.updateTaskStatus(task.id, 'completed')

    const results = await reconcileCoordinatorRunsOnBoot({ db: d })
    expect(results[0].disposition).toBe('finalized-completed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('completed')
  })

  it('finalizes a running run with no tasks as failed', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'empty', coordinatorHandle: 'c' })

    const results = await reconcileCoordinatorRunsOnBoot({ db: d })
    expect(results[0].disposition).toBe('finalized-failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('finalizes a running run with a failed task as failed', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'mixed', coordinatorHandle: 'c' })
    const a = d.createTask({ spec: 'A', coordinatorRunId: run.id })
    const b = d.createTask({ spec: 'B', coordinatorRunId: run.id })
    d.updateTaskStatus(a.id, 'completed')
    d.updateTaskStatus(b.id, 'failed')

    const results = await reconcileCoordinatorRunsOnBoot({ db: d })
    expect(results[0].disposition).toBe('finalized-failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('resumes a run with outstanding work when the resume callback succeeds', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'go', coordinatorHandle: 'c' })
    d.createTask({ spec: 'A', coordinatorRunId: run.id })

    const resumed: string[] = []
    const deps: ReconcileCoordinatorRunsOnBootDeps = {
      db: d,
      resume: async (r: CoordinatorRun) => {
        resumed.push(r.id)
        return 'resumed'
      }
    }
    const results = await reconcileCoordinatorRunsOnBoot(deps)
    expect(results[0].disposition).toBe('resumed')
    expect(resumed).toEqual([run.id])
    // A resumed run legitimately stays running (a live loop drives it).
    expect(d.getCoordinatorRun(run.id)?.status).toBe('running')
  })

  it('leaves a run running (skipped) when the resume callback reports contention', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'go', coordinatorHandle: 'c' })
    d.createTask({ spec: 'A', coordinatorRunId: run.id })

    // 'contended' = another runtime owns it; the reconciler must NOT fail it.
    const results = await reconcileCoordinatorRunsOnBoot({ db: d, resume: async () => 'contended' })
    expect(results[0].disposition).toBe('skipped')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('running')
  })

  it('falls back to failed when the resume callback declines', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'go', coordinatorHandle: 'c' })
    d.createTask({ spec: 'A', coordinatorRunId: run.id })

    const results = await reconcileCoordinatorRunsOnBoot({ db: d, resume: async () => 'declined' })
    expect(results[0].disposition).toBe('failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('isolates a per-run reconcile error so later running rows are not stranded', async () => {
    const d = createDb()
    const bad = d.startCoordinatorRun({
      spec: 'bad',
      coordinatorHandle: 'cb',
      targetKey: 'worktree:wtA'
    })
    d.createTask({ spec: 'A', coordinatorRunId: bad.id, targetKey: 'worktree:wtA' })
    const good = d.startCoordinatorRun({
      spec: 'good',
      coordinatorHandle: 'cg',
      targetKey: 'worktree:wtB'
    })
    d.createTask({ spec: 'B', coordinatorRunId: good.id, targetKey: 'worktree:wtB' })

    // The first run's resume throws inside a way the per-run try/catch must contain;
    // the second run must still be reconciled (here: declined → failed).
    const results = await reconcileCoordinatorRunsOnBoot({
      db: d,
      resume: async (r) => {
        if (r.id === bad.id) {
          throw new Error('transient boom')
        }
        return 'declined'
      }
    })
    const byId = Object.fromEntries(results.map((r) => [r.runId, r.disposition]))
    // bad: a throw is treated as declined → failed (never left running).
    expect(byId[bad.id]).toBe('failed')
    expect(d.getCoordinatorRun(bad.id)?.status).toBe('failed')
    // good: still processed despite bad's failure.
    expect(byId[good.id]).toBe('failed')
    expect(d.getCoordinatorRun(good.id)?.status).toBe('failed')
  })

  it('falls back to failed when the resume callback throws (never left running with no loop)', async () => {
    const d = createDb()
    const run = d.startCoordinatorRun({ spec: 'go', coordinatorHandle: 'c' })
    d.createTask({ spec: 'A', coordinatorRunId: run.id })

    const results = await reconcileCoordinatorRunsOnBoot({
      db: d,
      resume: async () => {
        throw new Error('resume boom')
      }
    })
    expect(results[0].disposition).toBe('failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('is target-isolated: only outstanding work on the run is considered (F1)', async () => {
    const d = createDb()
    // Two concurrent running rows on different targets (F1 allows this).
    const runA = d.startCoordinatorRun({
      spec: 'A',
      coordinatorHandle: 'ca',
      targetKey: 'worktree:wtA'
    })
    const runB = d.startCoordinatorRun({
      spec: 'B',
      coordinatorHandle: 'cb',
      targetKey: 'worktree:wtB'
    })
    d.createTask({ spec: 'A-1', coordinatorRunId: runA.id, targetKey: 'worktree:wtA' })
    // runB has no outstanding work → finalized-failed (no tasks), runA → failed.
    const results = await reconcileCoordinatorRunsOnBoot({ db: d })
    const byId = Object.fromEntries(results.map((r) => [r.runId, r.disposition]))
    expect(byId[runA.id]).toBe('failed')
    expect(byId[runB.id]).toBe('finalized-failed')
  })
})

describe('reclaimInFlightDispatchesForResume (F3 #14)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('returns dead in-flight dispatches to ready so the resumed loop converges', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({ spec: 'go', coordinatorHandle: 'c' })
    const task = d.createTask({ spec: 'A', coordinatorRunId: run.id })
    d.createDispatchContext(task.id, 'worker_x')
    expect(d.getTask(task.id)?.status).toBe('dispatched')

    const reclaimed = d.reclaimInFlightDispatchesForResume(run.id, 'restarted')
    expect(reclaimed).toBe(1)
    expect(d.getTask(task.id)?.status).toBe('ready')
  })
})

describe('buildAdoptedTrackWorktrees (F3 #14, design §8)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function lineage(partial: Partial<WorktreeLineage> & { worktreeId: string }): WorktreeLineage {
    return {
      worktreeInstanceId: `${partial.worktreeId}-inst`,
      parentWorktreeId: 'director',
      parentWorktreeInstanceId: 'director-inst',
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: 0,
      ...partial
    }
  }

  it('re-adopts only this run lineage children of the director, keyed by track, deduped', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'c',
      targetKey: 'worktree:director',
      worktreeBacked: true,
      workerAgent: 'claude'
    })
    // Lead task of track 'alpha' (declared in spec).
    const lead = d.createTask({ spec: 'track: alpha\nimplement X', coordinatorRunId: run.id })
    // A second same-track task (review) — should NOT add a second map entry.
    const review = d.createTask({ spec: 'track: alpha\nreview X', coordinatorRunId: run.id })

    const map = buildAdoptedTrackWorktrees(
      d,
      d.getCoordinatorRun(run.id)!,
      {
        leadChild: lineage({
          worktreeId: 'wt-alpha',
          orchestrationRunId: run.id,
          taskId: lead.id
        }),
        reviewChild: lineage({
          worktreeId: 'wt-alpha-2',
          orchestrationRunId: run.id,
          taskId: review.id
        }),
        otherRun: lineage({
          worktreeId: 'wt-other',
          orchestrationRunId: 'run_other',
          taskId: lead.id
        }),
        otherParent: lineage({
          worktreeId: 'wt-elsewhere',
          parentWorktreeId: 'someone-else',
          orchestrationRunId: run.id,
          taskId: lead.id
        })
      },
      'director',
      true
    )

    // One track ('alpha'), first child (the lead) wins; cross-run and
    // cross-parent children are ignored (F1 isolation + lineage scoping).
    expect([...map.keys()]).toEqual(['alpha'])
    const entry = map.get('alpha')!
    expect(entry.worktreeId).toBe('wt-alpha')
    expect(entry.isAgent).toBe(true)
    // Sentinel handle (the pre-crash terminal is dead) → relaunch on dispatch.
    expect(entry.terminalHandle).toBe('orch-readopt:wt-alpha')
  })

  it('defaults the track key to the task id when the spec declares no track', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'c',
      targetKey: 'worktree:director',
      worktreeBacked: true
    })
    const task = d.createTask({ spec: 'implement Y', coordinatorRunId: run.id })

    const map = buildAdoptedTrackWorktrees(
      d,
      d.getCoordinatorRun(run.id)!,
      {
        child: lineage({ worktreeId: 'wt-y', orchestrationRunId: run.id, taskId: task.id })
      },
      'director',
      false
    )
    expect([...map.keys()]).toEqual([task.id])
    expect(map.get(task.id)?.isAgent).toBe(false)
  })
})
