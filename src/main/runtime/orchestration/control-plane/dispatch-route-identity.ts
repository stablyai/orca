import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrchestrationDb } from '../db'
import type { RouteIdentity } from './route-registry-types'

/** The route a Dispatch actually launched on, read from the launch receipt the
 *  runtime persisted at `worker-start` (`worker_dispatches.start_options`).
 *
 *  This is runtime-observed evidence, not a model claim: `launch.effective` is
 *  written by `resolveWorkerLaunchPreferences` after the catalog resolved the
 *  request, so a route recorded here is what Orca actually asked the provider
 *  to run. It is deliberately `null` when nothing was recorded, so the caller
 *  omits the fact rather than guessing it.
 */
export function readDispatchRouteIdentity(
  db: OrchestrationDb,
  dispatchId: string
): RouteIdentity | null {
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(worker.start_options)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const options = parsed as Record<string, unknown>
  const launch = options.launch as { effective?: Record<string, unknown> } | undefined
  const effective = launch?.effective
  const agent = (effective?.agent ?? options.agent) as string | null | undefined
  if (typeof agent !== 'string' || agent.length === 0) {
    return null
  }
  const model = typeof effective?.model === 'string' ? effective.model : null
  const reasoning = typeof effective?.effort === 'string' ? effective.effort : null
  return { agent: agent as TuiAgent, model, reasoning }
}
