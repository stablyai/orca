import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb, CoordinatorRunConflictError } from './db'

// Why: regression suite for issue #12 / Orca bug #4389. Two coordinator runs
// shared one orchestration DB and poached each other's work because the task
// DAG, dispatch contexts, and decision gates were a single global namespace,
// while message inboxes collided on the literal 'coordinator' handle. These
// tests pin the per-run isolation invariants (Approach B: coordinator_run_id
// scoping + per-run handle + atomic run-start). See DECISION.md.
//
// The bug is a *concurrent* clash, so the isolation tests create two runs that
// are both 'running' at once and assert neither sees the other's rows. (Two
// running rows coexist via the plain createCoordinatorRun insert; the RPC path
// serializes starts via startCoordinatorRun — covered separately below.)
describe('orchestration per-run isolation (issue #12)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function twoConcurrentRuns(d: OrchestrationDb): { runA: string; runB: string } {
    const runA = d.createCoordinatorRun({ spec: 'A', coordinatorHandle: 'coordinator-a' })
    const runB = d.createCoordinatorRun({ spec: 'B', coordinatorHandle: 'coordinator-b' })
    return { runA: runA.id, runB: runB.id }
  }

  it('REPRO: a run must not see the other run tasks via listTasks', () => {
    const d = createDb()
    const { runA, runB } = twoConcurrentRuns(d)

    d.createTask({ spec: 'A-1', coordinatorRunId: runA })
    d.createTask({ spec: 'A-2', coordinatorRunId: runA })
    d.createTask({ spec: 'B-1', coordinatorRunId: runB })

    expect(d.listTasks({ ready: true, coordinatorRunId: runB }).map((t) => t.spec)).toEqual(['B-1'])
    expect(
      d
        .listTasks({ coordinatorRunId: runA })
        .map((t) => t.spec)
        .sort()
    ).toEqual(['A-1', 'A-2'])
  })

  it('REPRO: the dispatch uniqueness guard is scoped per run, not global', () => {
    const d = createDb()
    const { runA, runB } = twoConcurrentRuns(d)
    const taskA = d.createTask({ spec: 'A-1', coordinatorRunId: runA })
    const taskB = d.createTask({ spec: 'B-1', coordinatorRunId: runB })

    d.createDispatchContext(taskA.id, 'worker_shared')
    // Different run, same worker handle: must NOT trip "already working".
    expect(() => d.createDispatchContext(taskB.id, 'worker_shared')).not.toThrow()
    // Same run, same handle, second active dispatch: still rejected.
    const taskA2 = d.createTask({ spec: 'A-2', coordinatorRunId: runA })
    expect(() => d.createDispatchContext(taskA2.id, 'worker_shared')).toThrow(
      /already has an active dispatch/
    )
  })

  it('REPRO: getStaleDispatches / countActiveDispatches are run-scoped', () => {
    const d = createDb()
    const { runA, runB } = twoConcurrentRuns(d)
    const taskA = d.createTask({ spec: 'A-1', coordinatorRunId: runA })
    const taskB = d.createTask({ spec: 'B-1', coordinatorRunId: runB })
    d.createDispatchContext(taskA.id, 'worker_a')
    d.createDispatchContext(taskB.id, 'worker_b')

    expect(d.countActiveDispatches(runA)).toBe(1)
    expect(d.countActiveDispatches(runB)).toBe(1)
    expect(d.countActiveDispatches()).toBe(2)

    // Backdate run A's dispatch far past the grace window; keep run B's fresh.
    // Both use ISO timestamps so the lexicographic compare in getStaleDispatches
    // matches the ISO threshold (SQLite's datetime('now') space-format would
    // sort before any 'T'-delimited ISO string).
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const fresh = new Date().toISOString()
    const sqlite = (
      d as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }
    ).db
    sqlite
      .prepare("UPDATE dispatch_contexts SET dispatched_at = ? WHERE assignee_handle = 'worker_a'")
      .run(longAgo)
    sqlite
      .prepare("UPDATE dispatch_contexts SET dispatched_at = ? WHERE assignee_handle = 'worker_b'")
      .run(fresh)

    const threshold = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    expect(d.getStaleDispatches(threshold, runA).map((c) => c.assignee_handle)).toEqual([
      'worker_a'
    ])
    expect(d.getStaleDispatches(threshold, runB)).toHaveLength(0)
  })

  it('REPRO: listGates({status}) is run-scoped', () => {
    const d = createDb()
    const { runA, runB } = twoConcurrentRuns(d)
    const taskA = d.createTask({ spec: 'A-1', coordinatorRunId: runA })
    const taskB = d.createTask({ spec: 'B-1', coordinatorRunId: runB })
    d.createGate({ taskId: taskA.id, question: 'A?' })
    d.createGate({ taskId: taskB.id, question: 'B?' })

    expect(
      d.listGates({ status: 'pending', coordinatorRunId: runB }).map((g) => g.task_id)
    ).toEqual([taskB.id])
    expect(
      d.listGates({ status: 'pending', coordinatorRunId: runA }).map((g) => g.task_id)
    ).toEqual([taskA.id])
  })

  describe('task adoption', () => {
    it('claims pre-run (unowned) tasks for the starting run', () => {
      const d = createDb()
      const preTask = d.createTask({ spec: 'pre-run' })
      expect(preTask.coordinator_run_id).toBeNull()

      const runA = d.createCoordinatorRun({ spec: 'A', coordinatorHandle: 'coordinator-a' })
      d.adoptUnownedTasks(runA.id, null)

      expect(d.getTask(preTask.id)?.coordinator_run_id).toBe(runA.id)
    })

    it('never steals a concurrently-running run tasks', () => {
      const d = createDb()
      const { runA, runB } = twoConcurrentRuns(d)
      const ownedByA = d.createTask({ spec: 'A-1', coordinatorRunId: runA })

      d.adoptUnownedTasks(runB, null)

      // Run A is still running, so its task is untouched (no poaching).
      expect(d.getTask(ownedByA.id)?.coordinator_run_id).toBe(runA)
    })

    it('reclaims tasks left by a run that is no longer running', () => {
      const d = createDb()
      const runA = d.createCoordinatorRun({ spec: 'A', coordinatorHandle: 'coordinator-a' })
      const leftover = d.createTask({ spec: 'A-1', coordinatorRunId: runA.id })
      d.updateCoordinatorRun(runA.id, 'failed')

      const runB = d.createCoordinatorRun({ spec: 'B', coordinatorHandle: 'coordinator-b' })
      d.adoptUnownedTasks(runB.id, null)

      expect(d.getTask(leftover.id)?.coordinator_run_id).toBe(runB.id)
    })

    // Round-3 blocker repro: per-target run-start (round 2) without per-target
    // task ownership lets the first concurrent run swallow the other target's
    // unowned tasks. Each run must adopt ONLY its own target's tasks.
    it('adopts only its own target tasks under concurrency (no cross-target poaching)', () => {
      const d = createDb()
      // Unowned tasks for two distinct targets, created before any run.
      const xTask = d.createTask({ spec: 'X-1', targetKey: 'worktree:x' })
      const yTask = d.createTask({ spec: 'Y-1', targetKey: 'worktree:y' })
      expect(xTask.target_key).toBe('worktree:x')

      // Two genuinely concurrent runs on different targets (both running).
      const runA = d.startCoordinatorRun({
        spec: 'A',
        coordinatorHandle: 'coordinator-a',
        targetKey: 'worktree:x'
      })
      const runB = d.startCoordinatorRun({
        spec: 'B',
        coordinatorHandle: 'coordinator-b',
        targetKey: 'worktree:y'
      })

      d.adoptUnownedTasks(runA.id, 'worktree:x')
      d.adoptUnownedTasks(runB.id, 'worktree:y')

      // Disjoint: neither run poached the other's task.
      expect(d.getTask(xTask.id)?.coordinator_run_id).toBe(runA.id)
      expect(d.getTask(yTask.id)?.coordinator_run_id).toBe(runB.id)
      expect(d.listTasks({ coordinatorRunId: runA.id }).map((t) => t.spec)).toEqual(['X-1'])
      expect(d.listTasks({ coordinatorRunId: runB.id }).map((t) => t.spec)).toEqual(['Y-1'])
    })

    it('does not adopt a different target unowned task (target mismatch stays NULL)', () => {
      const d = createDb()
      const xTask = d.createTask({ spec: 'X-1', targetKey: 'worktree:x' })

      const runB = d.createCoordinatorRun({
        spec: 'B',
        coordinatorHandle: 'coordinator-b',
        targetKey: 'worktree:y'
      })
      d.adoptUnownedTasks(runB.id, 'worktree:y')

      expect(d.getTask(xTask.id)?.coordinator_run_id).toBeNull()
    })
  })

  describe('atomic, per-target run-start (TOCTOU close)', () => {
    it('rejects a second run on the SAME target', () => {
      const d = createDb()
      d.startCoordinatorRun({ spec: 'A', coordinatorHandle: 'coordinator-a', targetKey: 'repo:x' })
      expect(() =>
        d.startCoordinatorRun({
          spec: 'B',
          coordinatorHandle: 'coordinator-b',
          targetKey: 'repo:x'
        })
      ).toThrow(CoordinatorRunConflictError)
    })

    it('allows concurrent runs on DIFFERENT targets', () => {
      const d = createDb()
      const a = d.startCoordinatorRun({
        spec: 'A',
        coordinatorHandle: 'coordinator-a',
        targetKey: 'repo:x'
      })
      const b = d.startCoordinatorRun({
        spec: 'B',
        coordinatorHandle: 'coordinator-b',
        targetKey: 'repo:y'
      })
      expect(a.status).toBe('running')
      expect(b.status).toBe('running')
      expect(
        d
          .listCoordinatorRuns({ status: 'running' })
          .map((r) => r.id)
          .sort()
      ).toEqual([a.id, b.id].sort())
    })

    it('treats a null target_key as a single shared slot', () => {
      const d = createDb()
      d.startCoordinatorRun({ spec: 'A', coordinatorHandle: 'coordinator-a' })
      expect(() =>
        d.startCoordinatorRun({ spec: 'B', coordinatorHandle: 'coordinator-b' })
      ).toThrow(CoordinatorRunConflictError)
    })

    it('does not leave a dangling transaction after a rejected start', () => {
      const d = createDb()
      const runA = d.startCoordinatorRun({
        spec: 'A',
        coordinatorHandle: 'coordinator-a',
        targetKey: 'repo:x'
      })
      expect(() =>
        d.startCoordinatorRun({ spec: 'B', coordinatorHandle: 'b', targetKey: 'repo:x' })
      ).toThrow()
      // The DB is still writable (the failed start rolled back cleanly).
      d.updateCoordinatorRun(runA.id, 'completed')
      const runC = d.startCoordinatorRun({
        spec: 'C',
        coordinatorHandle: 'coordinator-c',
        targetKey: 'repo:x'
      })
      expect(runC.status).toBe('running')
    })
  })

  // Why (#12): the actual bug repro shape — two runtimes (two OrchestrationDb
  // connections) sharing ONE on-disk file. A :memory: DB is single-connection by
  // construction and cannot exercise the BEGIN IMMEDIATE cross-connection lock,
  // so these use a real temp file. The first start commits a running row; the
  // second connection's BEGIN IMMEDIATE check sees it through the shared file.
  describe('cross-connection atomic run-start (two runtimes, one file)', () => {
    let tempDir: string
    let dbA: OrchestrationDb | undefined
    let dbB: OrchestrationDb | undefined

    afterEach(() => {
      dbA?.close()
      dbB?.close()
      dbA = undefined
      dbB = undefined
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    function openTwoOnOneFile(): { a: OrchestrationDb; b: OrchestrationDb } {
      tempDir = mkdtempSync(join(tmpdir(), 'orca-orch-race-'))
      const path = join(tempDir, 'orchestration.db')
      dbA = new OrchestrationDb(path)
      dbB = new OrchestrationDb(path)
      return { a: dbA, b: dbB }
    }

    it('same target: exactly one connection wins', () => {
      const { a, b } = openTwoOnOneFile()
      const won = a.startCoordinatorRun({
        spec: 'A',
        coordinatorHandle: 'coordinator-a',
        targetKey: 'repo:x'
      })
      expect(won.status).toBe('running')
      // Second runtime, same file, same target → rejected via the shared lock.
      expect(() =>
        b.startCoordinatorRun({
          spec: 'B',
          coordinatorHandle: 'coordinator-b',
          targetKey: 'repo:x'
        })
      ).toThrow(CoordinatorRunConflictError)
      expect(b.listCoordinatorRuns({ status: 'running' })).toHaveLength(1)
    })

    it('different targets: both connections succeed', () => {
      const { a, b } = openTwoOnOneFile()
      const ra = a.startCoordinatorRun({
        spec: 'A',
        coordinatorHandle: 'coordinator-a',
        targetKey: 'repo:x'
      })
      const rb = b.startCoordinatorRun({
        spec: 'B',
        coordinatorHandle: 'coordinator-b',
        targetKey: 'repo:y'
      })
      expect(ra.status).toBe('running')
      expect(rb.status).toBe('running')
      // Both runs are visible (and running) through either connection.
      expect(a.listCoordinatorRuns({ status: 'running' })).toHaveLength(2)
    })
  })
})
