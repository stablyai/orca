import {
  PHASE_LAUNCH_CALLER_FINGERPRINT,
  drivePhaseLaunches,
  type PhaseStartRequest,
  type PhaseStartResult,
  type PhaseWorkerStarter
} from '../../orchestration/control-plane/phase-launch-driver'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_WORKER_START_METHODS } from './orchestration-workers'
import { readDispatchLaunchReceipt } from '../../orchestration/control-plane/dispatch-route-identity'
import { reconcileLifecycleAdvanceFailures } from '../../orchestration/control-plane/completion-gate-enforcement'
import { runCommandForStdout } from '../../orchestration/control-plane/sync-command-output'

/** B7 (correction 3) — the adapter from a planned phase to the EXISTING
 *  `orchestration.workerStart` method. There is no parallel launcher: this
 *  builds the same params a coordinator would send and invokes the same
 *  handler, so worktree placement, admission, capability minting, readiness
 *  waiting and the retained-session path are all the ones already in use.
 */

const WORKER_START = ORCHESTRATION_WORKER_START_METHODS.find(
  (method) => method.name === 'orchestration.workerStart'
)

/** Codes worker-start raises that mean "no session was created", so a retry is
 *  safe. Anything else is treated as unknown and reconciled first. */
const DETERMINISTIC_BLOCKERS = new Set([
  'route_not_certified',
  'route_excluded',
  'agent_unconfigured',
  'validation_in_progress',
  'consumer_fenced',
  'task_not_found',
  'task_not_startable'
])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function acceptedDispatchMatchesPhase(
  db: OrchestrationDb,
  dispatchId: string,
  request: PhaseStartRequest
): boolean {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  if (
    !dispatch ||
    !worker ||
    dispatch.run_id !== request.runId ||
    dispatch.task_id !== request.taskId ||
    !['ready', 'succeeded'].includes(worker.state) ||
    worker.stage !== 'input_accepted' ||
    !['dispatched', 'completed'].includes(dispatch.status) ||
    !dispatch.process_incarnation ||
    (request.worktreeId !== null && worker.worktree_id !== request.worktreeId)
  ) {
    return false
  }
  let options: Record<string, unknown>
  try {
    options = JSON.parse(worker.start_options) as Record<string, unknown>
  } catch {
    return false
  }
  if (options.baseSha !== request.boundSha) {
    return false
  }
  if (request.terminalHandle) {
    return (
      options.terminal === request.terminalHandle &&
      (!dispatch.assignee_handle || dispatch.assignee_handle === request.terminalHandle)
    )
  }
  const launch = readDispatchLaunchReceipt(db, dispatchId)
  return Boolean(
    launch?.requested &&
    launch.requested.agent === request.route.agent &&
    launch.requested.model === request.route.model &&
    launch.requested.reasoning === request.route.reasoning &&
    (options.resolvedWorktreeId === request.worktreeId || worker.worktree_id === request.worktreeId)
  )
}

/** Reads the exact Dispatch a previous, possibly lost, worker-start accepted.
 *  Only the stable mutation receipt can associate a Dispatch with this phase.
 *  A Task's latest Dispatch is not sufficient: it may be failed, unrelated, or
 *  left by an older attempt. */
function recoverAcceptedDispatch(
  db: OrchestrationDb,
  request: PhaseStartRequest
): { dispatchId: string } | null {
  const receipt = db.getMutationReceipt(PHASE_LAUNCH_CALLER_FINGERPRINT, request.mutationRequestId)
  if (receipt?.receipt) {
    try {
      const parsed = JSON.parse(receipt.receipt) as { accepted?: { dispatchId?: string } }
      if (
        parsed.accepted?.dispatchId &&
        acceptedDispatchMatchesPhase(db, parsed.accepted.dispatchId, request)
      ) {
        return { dispatchId: parsed.accepted.dispatchId }
      }
    } catch {
      // Fall through to the Dispatch row below.
    }
  }
  return null
}

export function createPhaseWorkerStarter(args: {
  runtime: OrcaRuntimeService
  ctx: RpcContext
  coordinatorHandle: string
}): PhaseWorkerStarter {
  const db = args.runtime.getOrchestrationDb()
  return {
    async reconcile(request) {
      return recoverAcceptedDispatch(db, request)
    },
    async start(request): Promise<PhaseStartResult> {
      if (!WORKER_START) {
        return { kind: 'failed', reason: 'orchestration.workerStart is not registered.' }
      }
      if (!request.worktreeId) {
        return {
          kind: 'blocked',
          reason: `Phase ${request.phaseId} has no exact worktree bound to ${request.boundSha}.`
        }
      }
      let observedHead: string | null = null
      try {
        const worktree = await args.runtime.showManagedTerminalWorkspace(`id:${request.worktreeId}`)
        observedHead = worktree.path
          ? runCommandForStdout({
              program: 'git',
              args: ['-C', worktree.path, 'rev-parse', 'HEAD']
            }).trim()
          : null
      } catch {
        observedHead = null
      }
      if (observedHead !== request.boundSha) {
        return {
          kind: 'blocked',
          reason: `Phase ${request.phaseId} is bound to ${request.boundSha}, but its worktree is at ${observedHead ?? '<unobservable>'}.`
        }
      }
      const params = WORKER_START.params?.parse({
        task: request.taskId,
        run: request.runId,
        from: args.coordinatorHandle,
        // A retained re-engagement names the existing terminal, which is what
        // makes worker-start reuse that session instead of creating one.
        ...(request.terminalHandle
          ? { terminal: request.terminalHandle }
          : {
              // Why the exact worktree: the reviewer must open the tree that
              // holds the reviewed commit, not wherever the coordinator sits.
              worktree: request.worktreeId ? `id:${request.worktreeId}` : 'current',
              agent: request.route.agent,
              ...(request.route.model ? { model: request.route.model } : {}),
              ...(request.route.reasoning ? { effort: request.route.reasoning } : {})
            })
      })
      try {
        const result = (await WORKER_START.handler(params, {
          ...args.ctx,
          runtime: args.runtime,
          orchestrationMutation: {
            callerFingerprint: PHASE_LAUNCH_CALLER_FINGERPRINT,
            requestId: request.mutationRequestId,
            method: 'orchestration.workerStart',
            payloadHash: request.payloadHash
          }
        })) as { dispatchId?: string; state?: string }
        if (!result.dispatchId) {
          return { kind: 'unknown', reason: 'worker-start returned no Dispatch id.' }
        }
        // A failed start still produced a real Dispatch row; recording it keeps
        // the loop from starting a second session for the same phase.
        return result.state === 'failed'
          ? {
              kind: 'failed',
              reason: `worker-start failed for Dispatch ${result.dispatchId}.`,
              dispatchId: result.dispatchId
            }
          : { kind: 'started', dispatchId: result.dispatchId }
      } catch (error) {
        const code = errorCode(error)
        if (code === 'operation_unknown' || code === 'request_mismatch') {
          const recovered = recoverAcceptedDispatch(db, request)
          return recovered
            ? { kind: 'started', dispatchId: recovered.dispatchId }
            : {
                kind: 'unknown',
                reason: `Durable request ${request.mutationRequestId} is unresolved.`
              }
        }
        if (code && DETERMINISTIC_BLOCKERS.has(code)) {
          return { kind: 'blocked', reason: `${code}: ${String(error)}` }
        }
        return { kind: 'unknown', reason: String(error) }
      }
    }
  }
}

/** Runs the driver for one Run using the live runtime. Safe to call on every
 *  completion and on every `orchestration.await` tick. */
export async function driveRunPhaseLaunches(args: {
  runtime: OrcaRuntimeService
  ctx: RpcContext
  runId: string
}): Promise<void> {
  const db = args.runtime.getOrchestrationDb()
  const run = db.getRun(args.runId)
  if (!run?.coordinator_handle) {
    // Without a bound coordinator terminal there is no authority to launch
    // under; the phase stays pending and is retried on the next tick.
    return
  }
  const build = args.runtime.getBuildIdentity()
  reconcileLifecycleAdvanceFailures({
    db,
    runId: args.runId,
    hooks: {
      nowMs: Date.now(),
      currentCommitSha: build.commitSha ?? undefined,
      currentRuntimeVersion: build.id,
      notify: (handle, messageType) => args.runtime.notifyMessageArrived(handle, messageType)
    }
  })
  await drivePhaseLaunches({
    db,
    runId: args.runId,
    nowMs: Date.now(),
    runtimeEpoch: args.runtime.getRuntimeId(),
    starter: createPhaseWorkerStarter({
      runtime: args.runtime,
      ctx: args.ctx,
      coordinatorHandle: run.coordinator_handle
    }),
    notify: (handle, messageType) => args.runtime.notifyMessageArrived(handle, messageType)
  })
}
