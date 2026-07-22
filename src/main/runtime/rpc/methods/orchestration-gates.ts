import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import type { CoordinatorRun, GateStatus } from '../../orchestration/db'
import { Coordinator } from '../../orchestration/coordinator'

// Why (#4389): live coordinators are keyed by workspace scope so concurrent
// orchestrators in different worktrees of one Orca instance don't orphan or
// stop each other. A 2nd run in another workspace adds its own entry instead of
// overwriting a single module-level reference, and runStop halts only the
// coordinator for the requested workspace. The unscoped/global run (no
// worktree selector or `--worktree all`) uses a fixed sentinel key so its
// pre-#4389 single-coordinator semantics are preserved.
const GLOBAL_COORDINATOR_KEY = '__global__'
const activeCoordinators = new Map<string, Coordinator>()

function coordinatorMapKey(workspaceKey: string | null): string {
  return workspaceKey ?? GLOBAL_COORDINATOR_KEY
}

function normalizeOrchestrationWorktreeSelector(worktree?: string | null): string | undefined {
  return worktree === 'all' ? undefined : (worktree ?? undefined)
}

function stopCoordinatorForRun(run: CoordinatorRun): void {
  const mapKey = coordinatorMapKey(run.workspace_key)
  const coordinator = activeCoordinators.get(mapKey)
  if (coordinator) {
    coordinator.stop()
    activeCoordinators.delete(mapKey)
  }
}

const RunParams = z.object({
  spec: requiredString('Missing --spec'),
  from: OptionalString,
  pollIntervalMs: OptionalFiniteNumber,
  maxConcurrent: OptionalFiniteNumber,
  worktree: OptionalString
})

const RunStopParams = z.object({
  worktree: OptionalString
})

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
      const worktree = normalizeOrchestrationWorktreeSelector(params.worktree)

      // Why (#4389): scope the active-run guard to this worktree so a 2nd
      // orchestrator in a different workspace is not rejected by another
      // workspace's running coordinator. A null key (no worktree or
      // `--worktree all`) is the explicit global coordinator; because it sees
      // every task, it still conflicts with any running scoped coordinator.
      const workspaceKey = await runtime.resolveWorkspaceKeyForSelector(worktree)
      const existing = db.getActiveCoordinatorRun(workspaceKey)
      if (existing) {
        throw new Error(`Coordinator already running: ${existing.id}`)
      }

      const coordinatorHandle = params.from ?? 'coordinator'
      const coordinator = new Coordinator(db, runtime, {
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs,
        maxConcurrent: params.maxConcurrent,
        worktree,
        workspaceKey
      })

      const mapKey = coordinatorMapKey(workspaceKey)
      activeCoordinators.set(mapKey, coordinator)

      const run = db.createCoordinatorRun({
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs,
        workspaceKey
      })

      // Why: fire-and-forget — the coordinator loop runs in the event loop
      // background. Results are persisted to the DB; callers query via
      // orchestration.taskList or orchestration.runStatus.
      coordinator.runFromExistingRun(run.id).finally(() => {
        // Why (#4389): only clear this workspace's slot, and only if it still
        // points at this coordinator — a newer run for the same workspace must
        // not be evicted by an older one's completion.
        if (activeCoordinators.get(mapKey) === coordinator) {
          activeCoordinators.delete(mapKey)
        }
      })

      return { runId: run.id, status: 'running' }
    }
  }),

  defineMethod({
    name: 'orchestration.runStop',
    params: RunStopParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const worktree = normalizeOrchestrationWorktreeSelector(params.worktree)

      let run: CoordinatorRun | undefined
      if (params.worktree === 'all') {
        run = db.getActiveGlobalCoordinatorRun()
        if (!run) {
          throw new Error('No active global coordinator run')
        }
      } else if (worktree) {
        // Why (#4389): explicit scoped stops must be exact. Scoped read helpers
        // intentionally include legacy NULL rows for task visibility, but using
        // that fallback here could report a global run as stopped while leaving
        // the live global coordinator running.
        const workspaceKey = await runtime.resolveWorkspaceKeyForSelector(worktree)
        run =
          workspaceKey === null
            ? db.getActiveGlobalCoordinatorRun()
            : db.getActiveCoordinatorRunForWorkspace(workspaceKey)
        if (!run) {
          throw new Error('No active coordinator run for requested worktree')
        }
      } else {
        const activeRuns = db.listActiveCoordinatorRuns()
        if (activeRuns.length === 0) {
          throw new Error('No active coordinator run')
        }
        if (activeRuns.length > 1) {
          throw new Error(
            'Multiple active coordinator runs; pass --worktree <selector> or --worktree all'
          )
        }
        run = activeRuns[0]
      }

      stopCoordinatorForRun(run)

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
