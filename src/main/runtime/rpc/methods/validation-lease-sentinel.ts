import { clearFenceSentinel, writeFenceSentinel } from '../../../agent-hooks/pretool-fence-sentinel'
import { z } from 'zod'
import { agentHookServer } from '../../../agent-hooks/server'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString } from '../schemas'

/** The durable fence sentinel lives beside the managed scripts' endpoint file.
 *  Both writes are best-effort: the live gate is the primary fence, and a
 *  sentinel that cannot be written must not fail the lease that protects. */
export function writeSentinelFor(worktreeId: string, leaseId: string, expiresAtMs: number): void {
  const endpointFilePath = agentHookServer.getEndpointFilePath()
  if (!endpointFilePath) {
    // Reporting a lease acquired with no offline fence is the failure this
    // whole path exists to prevent: the caller proceeds believing the tree is
    // guarded, and the moment Orca blinks it is not. Refuse instead.
    throw new OrchestrationError(
      'fence_sentinel_unavailable',
      'This runtime has no agent-hook endpoint, so the offline validation fence cannot be established and a lease here could not be enforced while Orca is unreachable.'
    )
  }
  // Throws on failure by design: the caller rolls the lease back rather than
  // reporting a protection whose offline half does not exist.
  writeFenceSentinel({ endpointFilePath, worktreeId, leaseId, expiresAtMs })
}

export function clearSentinelFor(worktreeId: string): void {
  const endpointFilePath = agentHookServer.getEndpointFilePath()
  if (endpointFilePath) {
    clearFenceSentinel(endpointFilePath, worktreeId)
  }
}

/** The Run this caller's own pane is bound to. Shared by the gate and lease
 *  methods so a Run can never be resolved two different ways. */
export function requireRunId(
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  from?: string
): string {
  const db = runtime.getOrchestrationDb()
  const paneKey = from ? runtime.getTerminalPaneKey(from) : null
  const run = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
  if (!run) {
    throw new OrchestrationError('run_not_bound', 'This operation requires a bound Run.')
  }
  return run.id
}

/** A lease binds one Task's work; naming the Dispatch alone would let a caller
 *  claim protection without saying which Task it believes it is protecting. */
export function requireTask(task: string | undefined, action: string): string {
  if (!task) {
    throw new OrchestrationError('invalid_argument', `${action} requires --task.`)
  }
  return task
}

export const ValidationLeaseParams = z.object({
  from: OptionalString,
  run: OptionalString,
  action: z.enum(['acquire', 'release', 'check']),
  dispatch: OptionalString,
  // Why required for acquire/release: a lease is bound to exactly one Task's
  // work, and a Dispatch's own task_id alone would let the caller name a
  // Dispatch without ever showing which Task it believes it is protecting.
  task: OptionalString,
  leaseId: OptionalString,
  idempotencyKey: OptionalString,
  ttlMs: OptionalFiniteNumber
})
