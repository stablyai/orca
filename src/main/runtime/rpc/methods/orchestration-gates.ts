import { randomBytes } from 'crypto'
import { z } from 'zod'
import type { TuiAgent, WorktreeLineage } from '../../../../shared/types'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import {
  CoordinatorRunConflictError,
  type GateStatus,
  type OrchestrationDb,
  type CoordinatorRun
} from '../../orchestration/db'
import { Coordinator, type CoordinatorRuntime } from '../../orchestration/coordinator'
import {
  buildAdoptedTrackWorktrees,
  reconcileCoordinatorRunsOnBoot,
  type ReconcileRunOnBootResult,
  type ResumeOutcome
} from '../../orchestration/boot-resume'

// Why: the most-recently-started coordinator is stored at module scope so
// orchestration.runStop can signal it to halt. Concurrent runs on different
// targets are now supported (#12), so this holds only the latest — runStop
// targets that one. Per-run stop selection is left to F4 (renderer run binding).
let activeCoordinator: Coordinator | null = null

// Why (#12): each run gets a unique coordinator handle instead of the literal
// 'coordinator' default, so two runs' message inboxes can't collide and one
// run can't markAsRead another's worker_done/heartbeat (a silent-hang clash).
// 64 bits of entropy makes a handle collision across runs negligible — the
// handle is the message-isolation primitive.
function deriveCoordinatorHandle(): string {
  return `coordinator-${randomBytes(8).toString('hex')}`
}

const RunParams = z.object({
  spec: requiredString('Missing --spec'),
  from: OptionalString,
  pollIntervalMs: OptionalFiniteNumber,
  maxConcurrent: OptionalFiniteNumber,
  worktree: OptionalString,
  // Why (F2 #13): opt-in, default OFF. When set, each task runs in its own
  // lineage-visible child worktree (parent = the --worktree director) so the
  // run appears in Mission Control. Requires --worktree.
  worktreeBacked: OptionalBoolean,
  // Why (F2 #13): agent launched inside each worktree-backed track worktree.
  workerAgent: OptionalString
})

const RunStopParams = z.object({})

const GateCreateParams = z.object({
  task: requiredString('Missing --task'),
  question: requiredString('Missing --question'),
  options: OptionalString
})

const GateResolveParams = z.object({
  id: requiredString('Missing --id'),
  resolution: requiredString('Missing --resolution')
})

const GateListParams = z.object({
  task: OptionalString,
  status: z.enum(['pending', 'resolved', 'timeout']).optional()
})

export const ORCHESTRATION_GATE_METHODS: RpcMethod[] = [
  // Why: Section 4.12 — orchestration.run returns immediately with a run ID.
  // The coordinator loop runs in the background; progress is queried via
  // orchestration.taskList. This prevents the RPC call from blocking the
  // CLI (or any caller) for the entire duration of the pipeline.
  defineMethod({
    name: 'orchestration.run',
    params: RunParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()

      // Why (F2 #13, round 2): reject an unknown --worker-agent fast at the
      // boundary. Otherwise an invalid id flows to createManagedWorktree, which
      // throws 'Selected agent is disabled…' on every dispatch — feeding the
      // worktree-create retry/breaker path with a permanent error.
      if (params.workerAgent && !(params.workerAgent in TUI_AGENT_CONFIG)) {
        throw new Error(
          `Invalid --worker-agent '${params.workerAgent}'. Pass a known agent id (e.g. claude, codex).`
        )
      }

      // Why (F2 #13, round 3, should-fix #4): --worktree-backed without an agent is
      // a worktree-backed BARE-SHELL mode — workers run in a plain shell that can
      // never emit worker_done, so every track hangs. Require --worker-agent so the
      // worker is a real agent (the only configuration that completes).
      if (params.worktreeBacked && !params.workerAgent) {
        throw new Error(
          '--worktree-backed requires --worker-agent <id>: a worktree-backed worker must be ' +
            'an agent that can report worker_done (a bare shell never completes). ' +
            'Pass e.g. --worker-agent claude.'
        )
      }

      const coordinatorHandle = params.from ?? deriveCoordinatorHandle()

      // Why (#12): resolve the coordinator's worktree to a stable target key so
      // the start guard rejects only a duplicate run on the *same* repo/worktree
      // — concurrent Orcastrators in different repos start in parallel.
      // resolveOrchestrationTargetKey fails closed (it does NOT guess a key) so a
      // worktree that can't be resolved refuses the run rather than silently
      // using a divergent key that would let two coordinators share a target.
      let targetKey: string | null
      try {
        targetKey = await runtime.resolveOrchestrationTargetKey(params.worktree)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          `Cannot start coordinator: --worktree '${params.worktree}' did not resolve to a ` +
            `known worktree (${detail}). Pass a resolvable --worktree so the run is isolated ` +
            `to one target.`
        )
      }

      // Why (#12): atomic check+insert (BEGIN IMMEDIATE inside startCoordinatorRun)
      // closes the TOCTOU between "is a run active for this target?" and "insert
      // a running run" that let two runtimes sharing one DB both start a
      // coordinator on the same target.
      let run
      try {
        run = db.startCoordinatorRun({
          spec: params.spec,
          coordinatorHandle,
          pollIntervalMs: params.pollIntervalMs,
          targetKey,
          // Why (F3 #14): persist the in-memory-only coordinator options so a
          // restart can rebuild THIS run faithfully (worktree-backed vs legacy,
          // which agent, concurrency) instead of guessing and re-zombieing it.
          ...(params.maxConcurrent !== undefined ? { maxConcurrent: params.maxConcurrent } : {}),
          ...(params.worktreeBacked !== undefined ? { worktreeBacked: params.worktreeBacked } : {}),
          ...(params.workerAgent ? { workerAgent: params.workerAgent } : {})
        })
      } catch (err) {
        if (err instanceof CoordinatorRunConflictError) {
          throw new Error(err.message)
        }
        throw err
      }

      const coordinator = new Coordinator(db, runtime, {
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs,
        maxConcurrent: params.maxConcurrent,
        worktree: params.worktree,
        ...(params.worktreeBacked ? { worktreeBacked: true } : {}),
        ...(params.workerAgent ? { workerAgent: params.workerAgent as TuiAgent } : {})
      })

      activeCoordinator = coordinator

      // Why: fire-and-forget — the coordinator loop runs in the event loop
      // background. Results are persisted to the DB; callers query via
      // orchestration.taskList or orchestration.runStatus.
      coordinator.runFromExistingRun(run.id).finally(() => {
        if (activeCoordinator === coordinator) {
          activeCoordinator = null
        }
      })

      return { runId: run.id, status: 'running' }
    }
  }),

  defineMethod({
    name: 'orchestration.runStop',
    params: RunStopParams,
    handler: (_params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getActiveCoordinatorRun()
      if (!run) {
        throw new Error('No active coordinator run')
      }

      if (activeCoordinator) {
        activeCoordinator.stop()
        activeCoordinator = null
      }

      return { runId: run.id, stopped: true }
    }
  }),

  defineMethod({
    name: 'orchestration.gateCreate',
    params: GateCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      let options: string[] | undefined
      if (params.options) {
        try {
          const parsed = JSON.parse(params.options)
          if (!Array.isArray(parsed) || !parsed.every((option) => typeof option === 'string')) {
            throw new Error('not an array of strings')
          }
          options = parsed
        } catch {
          throw new Error('Invalid --options: must be a JSON array of strings')
        }
      }
      const gate = db.createGate({
        taskId: params.task,
        question: params.question,
        options
      })
      return { gate }
    }
  }),

  defineMethod({
    name: 'orchestration.gateResolve',
    params: GateResolveParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const gate = db.resolveGate(params.id, params.resolution)
      if (!gate) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      return { gate }
    }
  }),

  defineMethod({
    name: 'orchestration.gateList',
    params: GateListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const gates = db.listGates({
        taskId: params.task,
        status: params.status as GateStatus
      })
      return { gates, count: gates.length }
    }
  })
]

// Why (F3 #14): the runtime surface resume-on-boot needs. CoordinatorRuntime
// supplies the dispatch/worktree methods the rebuilt Coordinator uses; the three
// extras resolve the run's DB, verify the director worktree still exists, and
// read the lineage map for track re-adoption (the same map Mission Control uses).
type OrchestrationBootRuntime = CoordinatorRuntime & {
  getOrchestrationDb(): OrchestrationDb
  resolveOrchestrationTargetKey(selector?: string): Promise<string | null>
  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>>
  // Why (F3 #14, should-fix #4): the runtime boot time fences the atomic resume
  // claim so two runtimes sharing a DB can't both drive one run, while a later
  // boot reclaims a crashed resumer's stale claim.
  getStartedAt(): number
}

const WORKTREE_TARGET_PREFIX = 'worktree:'

// Why (F3 #14): rebuild and restart a crashed run's coordinator. Returns:
//  - 'contended' — another runtime won the atomic claim; leave the run running
//    (it has a live owner), do not touch it.
//  - 'declined' — WE own the claim but the run is not safely resumable (no
//    worktree target, pre-v9 unknown mode, or the director worktree is gone), so
//    the reconciler marks it failed (kills the zombie, unblocks the guard).
//  - 'resumed' — WE own the claim and started a converging loop.
// The claim is taken FIRST so a loser never declines→fails a run another runtime
// is driving. On the happy path it reclaims dead in-flight dispatches (so the loop
// converges), re-adopts existing track worktrees, registers the coordinator as
// active (so orchestration.runStop can halt it), and fires the loop — whose .catch
// force-fails the run if the loop ever rejects un-finalized (hard-rule belt).
async function resumeCoordinatorRunOnBoot(
  runtime: OrchestrationBootRuntime,
  db: OrchestrationDb,
  run: CoordinatorRun,
  onLog: (msg: string) => void
): Promise<ResumeOutcome> {
  // Atomic, boot-time-fenced claim FIRST: only the winner decides drive-vs-fail,
  // so a second runtime sharing the DB neither double-drives nor fails a run the
  // owner is driving.
  const fenceIso = new Date(runtime.getStartedAt()).toISOString()
  if (!db.tryClaimRunForResume(run.id, fenceIso)) {
    onLog(`Resume: run ${run.id} is claimed by another runtime; skipping`)
    return 'contended'
  }

  if (!run.target_key || !run.target_key.startsWith(WORKTREE_TARGET_PREFIX)) {
    onLog(`Resume: run ${run.id} has no worktree target; cannot resume`)
    return 'declined'
  }
  // Why (should-fix #3): a NULL worktree_backed predates v9 — we cannot tell if it
  // was worktree-backed. Guessing legacy would dispatch into a bare shell that never
  // reports done → never converges → re-resumes every restart. Fail it instead.
  // Only a genuine, explicitly-recorded legacy run (worktree_backed = 0) resumes in
  // legacy mode.
  if (run.worktree_backed === null) {
    onLog(`Resume: run ${run.id} predates v9 (worktree_backed unknown); cannot safely resume`)
    return 'declined'
  }
  const directorWorktreeId = run.target_key.slice(WORKTREE_TARGET_PREFIX.length)
  const directorSelector = `id:${directorWorktreeId}`
  try {
    // Throws when the director worktree was deleted while Orca was closed. We fail
    // closed (favor the hard rule): a run we cannot anchor converges to failed
    // rather than risk a zombie. (Distinguishing a transient resolve error from a
    // genuine not-found is a follow-up; fail-closed is the safe default here.)
    await runtime.resolveOrchestrationTargetKey(directorSelector)
  } catch {
    onLog(`Resume: run ${run.id} director worktree ${directorWorktreeId} is gone; cannot resume`)
    return 'declined'
  }

  const worktreeBacked = run.worktree_backed === 1
  const workerAgent = run.worker_agent ?? undefined

  // Converge-safety: a task left 'dispatched' by the crashed loop has a dead,
  // unmonitored worker — reclaim it to 'ready' so the resumed loop re-dispatches
  // (or breaker-fails) it rather than spinning forever on a hung dispatch.
  const reclaimed = db.reclaimInFlightDispatchesForResume(
    run.id,
    'reclaimed on boot: coordinator restarted'
  )
  if (reclaimed > 0) {
    onLog(`Resume: run ${run.id} reclaimed ${reclaimed} in-flight dispatch(es)`)
  }

  const coordinator = new Coordinator(db, runtime, {
    spec: run.spec,
    coordinatorHandle: run.coordinator_handle,
    pollIntervalMs: run.poll_interval_ms,
    ...(run.max_concurrent != null ? { maxConcurrent: run.max_concurrent } : {}),
    worktree: directorSelector,
    ...(worktreeBacked ? { worktreeBacked: true } : {}),
    ...(workerAgent ? { workerAgent: workerAgent as TuiAgent } : {}),
    onLog
  })

  if (worktreeBacked) {
    const lineage = await runtime.listWorktreeLineage()
    const entries = buildAdoptedTrackWorktrees(
      db,
      run,
      lineage,
      directorWorktreeId,
      workerAgent !== undefined
    )
    coordinator.seedAdoptedTrackWorktrees(entries)
    if (entries.size > 0) {
      onLog(`Resume: run ${run.id} re-adopted ${entries.size} track worktree(s)`)
    }
  }

  activeCoordinator = coordinator
  coordinator
    .runFromExistingRun(run.id)
    .catch((err) => {
      // Hard-rule belt (must-fix #1): if the loop ever rejects WITHOUT finalizing
      // (e.g. a future pre-try line in executeLoop throws), force the run to failed
      // so it can never be left 'running' with no live loop. Best-effort: a DB
      // closed/locked at shutdown must not crash the process.
      onLog(`Resume: run ${run.id} loop rejected; marking failed (${String(err)})`)
      try {
        db.updateCoordinatorRun(run.id, 'failed')
      } catch {
        // ignore — nothing more we can safely do here
      }
    })
    .finally(() => {
      if (activeCoordinator === coordinator) {
        activeCoordinator = null
      }
    })
  return 'resumed'
}

// Why (F3 #14): the boot entry point. Scans running coordinator runs and
// reconciles each (finalize / resume / fail) so a restart never leaves a zombie
// that blocks a fresh run for the target. Call once on app boot, before any
// launch path that checks the per-target active-run guard. Errors are the
// caller's to isolate — a reconcile failure must not block app startup.
export async function runOrchestrationBootReconcile(
  runtime: OrchestrationBootRuntime,
  onLog?: (msg: string) => void
): Promise<ReconcileRunOnBootResult[]> {
  const db = runtime.getOrchestrationDb()
  const log = onLog ?? (() => {})
  return reconcileCoordinatorRunsOnBoot({
    db,
    resume: (run) => resumeCoordinatorRunOnBoot(runtime, db, run, log),
    onLog: log
  })
}
