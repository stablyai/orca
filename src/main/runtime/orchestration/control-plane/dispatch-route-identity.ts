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

/** How the launch receipt's effective identity came to exist.
 *
 *  `requested_copy` is the honest name for what `createWorkerLaunchReceipt`
 *  writes today: it clones the request, so it proves the request was accepted
 *  and nothing about what the provider is actually running. Only `observed`
 *  may back effective-identity certification.
 */
export type EffectiveIdentityProvenance =
  /** A provider/session receipt reported this identity. The only kind that may
   *  back effective-identity certification. */
  | 'observed'
  /** Orca's catalog transformed the request. Proves the request was accepted,
   *  not what the provider is running. */
  | 'derived'
  /** A byte-for-byte clone of the request. */
  | 'requested_copy'
  | 'none'

export type DispatchLaunchReceipt = {
  requested: RouteIdentity | null
  effective: RouteIdentity | null
  effectiveProvenance: EffectiveIdentityProvenance
}

function toIdentity(value: unknown): RouteIdentity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const agent = record.agent
  if (typeof agent !== 'string' || agent.length === 0) {
    return null
  }
  return {
    agent: agent as TuiAgent,
    model: typeof record.model === 'string' ? record.model : null,
    reasoning: typeof record.effort === 'string' ? record.effort : null
  }
}

function sameSelection(left: RouteIdentity | null, right: RouteIdentity | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.agent === right.agent &&
    left.model === right.model &&
    left.reasoning === right.reasoning
  )
}

/** The full launch receipt, with the provenance of its effective identity. */
export function readDispatchLaunchReceipt(
  db: OrchestrationDb,
  dispatchId: string
): DispatchLaunchReceipt | null {
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
  const launch = options.launch as Record<string, unknown> | undefined
  const requested = toIdentity(launch?.requested)
  const effective = toIdentity(launch?.effective)
  if (!effective) {
    return { requested, effective: null, effectiveProvenance: 'none' }
  }
  // Why the explicit stamp wins: a provider-observed identity is recorded by the
  // runtime after the session reported itself, and only then is it a receipt.
  const stamped = (launch?.effectiveProvenance ?? null) as string | null
  if (stamped === 'observed') {
    return { requested, effective, effectiveProvenance: 'observed' }
  }
  // Why not "differs from requested implies observed": a catalog may legitimately
  // transform a request (cursor composes effort into the model id) without any
  // provider having reported anything. Only an explicit stamp is provenance.
  return {
    requested,
    effective,
    effectiveProvenance: sameSelection(requested, effective) ? 'requested_copy' : 'derived'
  }
}
