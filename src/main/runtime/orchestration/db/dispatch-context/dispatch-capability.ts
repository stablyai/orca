import { randomBytes, timingSafeEqual } from 'node:crypto'
import { OrchestrationError } from '../../orchestration-error'
import type { DispatchContextRow } from '../../types'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import { isEquivalentPaneKey } from '../pane-key-match'
import { exposeUtcTimestamp } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

// Why: "capability is revoked" describes the mechanism, not the cause, and an
// agent worker reads it as its authorization dying — the reported failure is a
// worker that quits with finished work uncommitted rather than one that reports
// again. State only what the row proves: whether this dispatch was settled or
// released, when, and the one channel that still works. Never guess why.
function describeRevokedDispatch(dispatch: DispatchContextRow): string {
  return [
    describeRevocationCause(dispatch),
    'This is final for worker_done and heartbeat: resending them cannot change it.',
    // Why not "escalation will reach the coordinator": that depends on topology
    // this function cannot see. The gate's scope is a fact; delivery is not.
    'This capability gates only worker_done and heartbeat, so if the task is not actually finished, report that with --type escalation.',
    'Do not exit with uncommitted work.'
  ].join('\n')
}

// Why every branch reads a stored column: a revoked row does not record who
// revoked it, so any sentence about stopping, releasing, or reporting early
// would be inference. `status` distinguishes the terminal cases, `last_failure`
// carries the real cause behind a `failed` row ('stopped', 'abandoned'), and a
// still-open status means the capability went before the dispatch settled.
function describeRevocationCause(dispatch: DispatchContextRow): string {
  const at = exposeUtcTimestamp(dispatch.completed_at ?? dispatch.capability_revoked_at)
  const when = at ? ` at ${at}` : ''
  if (dispatch.status === 'circuit_broken') {
    return `Dispatch ${dispatch.id} circuit-broke after ${dispatch.failure_count} failures${when}, which revoked its lifecycle capability.`
  }
  if (dispatch.status === 'completed' || dispatch.status === 'failed') {
    const cause = dispatch.last_failure ? ` (${dispatch.last_failure})` : ''
    return `Dispatch ${dispatch.id} was settled as ${dispatch.status}${cause}${when}, which revoked its lifecycle capability.`
  }
  return `Dispatch ${dispatch.id} had its lifecycle capability revoked${when} while still ${dispatch.status}.`
}

export function mintDispatchCapability(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
  }
): string {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${params.dispatchId} is not active.`
    )
  }
  const capability = `dcap_${randomBytes(32).toString('base64url')}`
  this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET capability_hash = ?, assignee_pane_key = ?, process_incarnation = ?,
           capability_revoked_at = NULL
       WHERE id = ?`
    )
    .run(
      hashDispatchCapability(capability),
      params.paneKey,
      params.processIncarnation,
      params.dispatchId
    )
  return capability
}

export function verifyDispatchCapability(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | undefined
    processIncarnation: string | undefined
  }
): { valid: true } | { valid: false; reason: string } {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch) {
    return { valid: false, reason: `Dispatch ${params.dispatchId} was not found.` }
  }
  if (!dispatch.capability_hash) {
    return { valid: false, reason: `Dispatch ${params.dispatchId} has no lifecycle capability.` }
  }
  if (!params.capability) {
    return { valid: false, reason: 'The Dispatch capability is missing.' }
  }
  const expected = Buffer.from(dispatch.capability_hash, 'hex')
  const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
  if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
    return { valid: false, reason: 'The Dispatch capability is invalid.' }
  }
  if (
    !dispatch.assignee_pane_key ||
    !params.paneKey ||
    !isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
  ) {
    return { valid: false, reason: 'The caller is not the Dispatch pane.' }
  }
  if (
    !dispatch.process_incarnation ||
    !params.processIncarnation ||
    dispatch.process_incarnation !== params.processIncarnation
  ) {
    return { valid: false, reason: 'The Dispatch process incarnation changed.' }
  }
  // Why revocation is checked last: only a caller that has proven it is this
  // dispatch's own worker gets told what happened to it. A caller that failed
  // identity now learns nothing about the dispatch's state, and the recovery
  // advice below is only ever addressed to someone who can act on it.
  if (dispatch.capability_revoked_at) {
    return { valid: false, reason: describeRevokedDispatch(dispatch) }
  }
  return { valid: true }
}

export function revokeDispatchCapability(this: OrchestrationDb, dispatchId: string): void {
  this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
       WHERE id = ?`
    )
    .run(dispatchId)
}

export type DispatchCapabilityMethods = {
  mintDispatchCapability: typeof mintDispatchCapability
  verifyDispatchCapability: typeof verifyDispatchCapability
  revokeDispatchCapability: typeof revokeDispatchCapability
}

export function attachDispatchCapability(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    mintDispatchCapability,
    verifyDispatchCapability,
    revokeDispatchCapability
  })
}
