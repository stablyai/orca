import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcMethod } from '../core'

/**
 * One pass both stamps the automatic-resume fence on every settled worker pane and lifts it from
 * every pane the recovery plan no longer claims. A fenced pane refuses a fresh spawn, so any path
 * that drops a worker's row from that plan — release, user retain, user takeover — has to run the
 * sweep in the same call, or the fence outlives its dispatch and the pane stays unspawnable until
 * the next app start. Failures are swallowed: a fence sweep must never fail the RPC behind it.
 */
export function sweepSettledWorkerResumeFences(runtime: OrcaRuntimeService): void {
  try {
    runtime.prepareLegacyWorkerTerminalRecovery()
  } catch (error) {
    console.warn('[orchestration] settled worker resume fence sweep failed', error)
  }
}

/** Settling a worker is what makes its pane fenceable, and release/retain/takeover are what make it
 *  unfenceable again — so every one of those has to sweep in the same call. Without the settlement
 *  half the fence only appeared at the next app start, and reopening the pane in the same session
 *  respawned the agent. */
const FENCE_SWEEPING_METHOD_NAMES = new Set([
  'orchestration.workerRelease',
  'orchestration.workerRetain',
  'orchestration.workerStop',
  'orchestration.workerAbandon',
  // Reusing a settled worker's pane for a new Dispatch drops the old row from the plan; without
  // this the stale fence stays on the pane it just relaunched into.
  'orchestration.workerStart'
])

export function sweepingSettledWorkerResumeFences(method: RpcMethod): RpcMethod {
  if (!FENCE_SWEEPING_METHOD_NAMES.has(method.name)) {
    return method
  }
  return {
    ...method,
    handler: async (params, ctx) => {
      const result = await method.handler(params, ctx)
      sweepSettledWorkerResumeFences(ctx.runtime)
      return result
    }
  }
}
