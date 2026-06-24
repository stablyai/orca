// Why (F3 #14): the Coordinator is an in-memory instance with no boot hook, so
// after an app restart a leftover `coordinator_runs.status='running'` row has no
// loop driving it. That zombie trips F1's per-target active-run guard
// (startCoordinatorRun's BEGIN IMMEDIATE check) and blocks a fresh run for that
// target forever. This module reconciles every running run on boot so the guard
// is unblocked: each run is finalized (its work was already done), resumed (a
// converging loop is restarted), or — the floor — marked failed. Hard rule: a run
// that cannot be resumed MUST converge to failed, never be left running with no
// loop. The reconcile is pure orchestration over the DB plus an injected resume
// callback, so it is testable without Electron or a live runtime.
import type { OrchestrationDb } from './db'
import type { CoordinatorRun, TaskRow } from './types'
import { parseTrackFromSpec } from './coordinator'
import type { WorktreeLineage } from '../../../shared/types'

export type BootRunDisposition =
  | 'finalized-completed'
  | 'finalized-failed'
  | 'resumed'
  | 'failed'
  | 'reconcile-error'
  // Why (F3 #14): another runtime won the atomic resume claim and is driving this
  // run, so we leave it 'running' (NOT a zombie — a live loop owns it) and do not
  // touch it. Distinct from 'resumed' (we drive it) and 'failed' (no driver).
  | 'skipped'

// Why (F3 #14): the resume callback's three outcomes the reconciler must tell
// apart. 'resumed' → a converging loop now drives it (stays running). 'declined'
// → unresumable, the reconciler marks it failed (kills the zombie). 'contended'
// → another runtime claimed it; leave it running (it has a live owner).
export type ResumeOutcome = 'resumed' | 'declined' | 'contended'

export type ReconcileRunOnBootResult = {
  runId: string
  disposition: BootRunDisposition
  reason?: string
}

export type ReconcileCoordinatorRunsOnBootDeps = {
  db: OrchestrationDb
  // Attempt to resume a run that still has outstanding work. 'resumed' keeps the
  // run 'running' under a live loop; 'declined' (or a throw) → the reconciler marks
  // it failed; 'contended' → another runtime owns it, leave it running. Omitted
  // entirely → MUST-only mode: every outstanding run is reconciled to failed.
  resume?: (run: CoordinatorRun) => Promise<ResumeOutcome>
  onLog?: (msg: string) => void
}

function isTerminal(task: TaskRow): boolean {
  return task.status === 'completed' || task.status === 'failed'
}

// Why: a running row whose tasks are all terminal (or which has no tasks) is not
// a resumable in-flight run — its loop already finished the work (or never had
// any) and only the row outlived the process. Finalize it to its real outcome so
// it stops blocking the guard: failed if any task failed OR there were no tasks
// (a run that never produced a converged DAG is a failure, matching the
// coordinator's own "No tasks found" → failed path); completed otherwise.
export function classifyOutstandingWork(
  db: OrchestrationDb,
  run: CoordinatorRun
): { outstanding: TaskRow[]; finalizeStatus: 'completed' | 'failed' | null } {
  const tasks = db.listTasks({ coordinatorRunId: run.id })
  const outstanding = tasks.filter((task) => !isTerminal(task))
  if (outstanding.length > 0) {
    return { outstanding, finalizeStatus: null }
  }
  const anyFailed = tasks.length === 0 || tasks.some((task) => task.status === 'failed')
  return { outstanding, finalizeStatus: anyFailed ? 'failed' : 'completed' }
}

export async function reconcileCoordinatorRunsOnBoot(
  deps: ReconcileCoordinatorRunsOnBootDeps
): Promise<ReconcileRunOnBootResult[]> {
  const { db, resume } = deps
  const onLog = deps.onLog ?? (() => {})
  // Snapshot the running rows up front. A resumed run stays 'running' but is now
  // claimed (resumed_at fenced), so a second pass's resume claim loses → 'contended'
  // → left alone: the pass is safe to repeat.
  const runs = db.listCoordinatorRuns({ status: 'running' })
  const results: ReconcileRunOnBootResult[] = []

  for (const run of runs) {
    // Why (F3 #14, should-fix #5): isolate each run. A transient DB error (e.g.
    // SQLITE_BUSY) on one row must not abort the loop and strand every LATER
    // running row as a zombie. Log and continue; the stranded row is retried next
    // boot (it is still 'running').
    try {
      results.push(await reconcileOneRunOnBoot(db, run, resume, onLog))
    } catch (err) {
      onLog(`Boot reconcile: run ${run.id} errored; left for next boot (${String(err)})`)
      results.push({ runId: run.id, disposition: 'reconcile-error', reason: String(err) })
    }
  }

  return results
}

async function reconcileOneRunOnBoot(
  db: OrchestrationDb,
  run: CoordinatorRun,
  resume: ((run: CoordinatorRun) => Promise<ResumeOutcome>) | undefined,
  onLog: (msg: string) => void
): Promise<ReconcileRunOnBootResult> {
  const { finalizeStatus } = classifyOutstandingWork(db, run)
  if (finalizeStatus) {
    db.updateCoordinatorRun(run.id, finalizeStatus)
    onLog(`Boot reconcile: run ${run.id} had no outstanding work; finalized as ${finalizeStatus}`)
    return {
      runId: run.id,
      disposition: finalizeStatus === 'failed' ? 'finalized-failed' : 'finalized-completed'
    }
  }

  if (resume) {
    let outcome: ResumeOutcome = 'declined'
    try {
      outcome = await resume(run)
    } catch (err) {
      // A throw is treated as declined → marked failed below (never left running).
      onLog(`Boot reconcile: resume of run ${run.id} threw; marking failed (${String(err)})`)
      outcome = 'declined'
    }
    if (outcome === 'resumed') {
      onLog(`Boot reconcile: resumed run ${run.id}`)
      return { runId: run.id, disposition: 'resumed' }
    }
    if (outcome === 'contended') {
      // Another runtime owns it (a live loop drives it) — leave it running.
      onLog(`Boot reconcile: run ${run.id} is owned by another runtime; left running`)
      return { runId: run.id, disposition: 'skipped' }
    }
  }

  // Floor: cannot/should not resume → converge to failed so the guard unblocks.
  const reason = 'coordinator restarted with no resumable loop'
  db.updateCoordinatorRun(run.id, 'failed')
  onLog(`Boot reconcile: run ${run.id} not resumed; marked failed (${reason})`)
  return { runId: run.id, disposition: 'failed', reason }
}

// Why (F3 #14, design §8): rebuild the coordinator's in-memory track→worktree map
// from lineage — the SAME `parentWorktreeId === directorWorktreeId` data Mission
// Control keys on — scoped to THIS run (orchestrationRunId) so a different run's
// children on the same director are never adopted. Each child's recorded taskId
// resolves to a task whose track key (spec `track:` hint → default = task id,
// mirroring Coordinator.trackKeyForTask) is the map key; the first child seen for
// a track (its lead task) wins. The seeded terminalHandle is a post-restart
// sentinel — the pre-crash handle is dead — so resolveTrackTerminal relaunches
// the worker agent in the existing checkout instead of trusting a stale handle.
export function buildAdoptedTrackWorktrees(
  db: OrchestrationDb,
  run: CoordinatorRun,
  lineageById: Record<string, WorktreeLineage>,
  directorWorktreeId: string,
  wantsAgent: boolean
): Map<string, { worktreeId: string; terminalHandle: string; isAgent: boolean }> {
  const map = new Map<string, { worktreeId: string; terminalHandle: string; isAgent: boolean }>()
  for (const lineage of Object.values(lineageById)) {
    if (lineage.parentWorktreeId !== directorWorktreeId) {
      continue
    }
    if (lineage.orchestrationRunId !== run.id) {
      continue
    }
    if (!lineage.taskId) {
      continue
    }
    const task = db.getTask(lineage.taskId)
    if (!task) {
      continue
    }
    const trackKey = parseTrackFromSpec(task.spec).trackKey ?? task.id
    if (map.has(trackKey)) {
      continue
    }
    map.set(trackKey, {
      worktreeId: lineage.worktreeId,
      terminalHandle: `orch-readopt:${lineage.worktreeId}`,
      isAgent: wantsAgent
    })
  }
  return map
}
