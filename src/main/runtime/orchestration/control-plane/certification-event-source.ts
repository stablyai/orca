import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { OrchestrationDb } from '../db'
import type { DispatchContextRow } from '../types'
import { selectDispatchAgentStatus } from './dispatch-liveness-evidence'
import { readDispatchLaunchReceipt } from './dispatch-route-identity'
import type { RouteEvidenceKind } from './route-certification-evidence'
import { sameRouteIdentity, type RouteIdentity, type SessionMode } from './route-registry-types'

/** Correction — certification evidence is DERIVED from runtime-owned events.
 *
 *  A caller may request that a kind be certified; it may not declare that the
 *  kind succeeded. Every rule below reads a fact the runtime itself recorded:
 *  a launch receipt, an agent-hook row, an accepted terminal completion, a
 *  recovery transition, a phase launch. When the runtime cannot observe the
 *  fact, the rule fails CLOSED — an unobservable kind is never PASS.
 */

export type EvidenceObservationCode =
  | 'not_launched'
  | 'session_mode_mismatch'
  | 'effective_identity_unobservable'
  | 'effective_identity_mismatch'
  | 'no_pretool_event'
  | 'no_safe_launch_token'
  | 'no_worktree_binding'
  | 'no_accepted_completion'
  | 'no_duplicate_prevented'
  | 'no_recovery_transition'
  | 'role_did_not_execute'

export type EvidenceObservation =
  | { observed: true; detail: string }
  | { observed: false; code: EvidenceObservationCode; reason: string }

/** The runtime facts the database alone cannot answer. */
export type CertificationObservationSource = {
  /** Provider-rendered effective identity for this Dispatch's own pane, or null
   *  when the runtime could not read one. Never the requested identity. */
  observedEffectiveIdentity(dispatchId: string): RouteIdentity | null
  agentStatusSnapshot(): readonly AgentStatusIpcPayload[]
}

export type EvidenceObservationRequest = {
  identity: RouteIdentity
  role: 'builder' | 'reviewer'
  sessionMode: SessionMode
  kind: RouteEvidenceKind
  dispatchId: string
}

function ok(detail: string): EvidenceObservation {
  return { observed: true, detail }
}

function no(code: EvidenceObservationCode, reason: string): EvidenceObservation {
  return { observed: false, code, reason }
}

/** True when the Dispatch created its own agent pane rather than re-engaging
 *  one. The runtime records this in the worker's own effects list at start. */
function isFreshSession(db: OrchestrationDb, dispatch: DispatchContextRow): boolean {
  const worker = db.getWorkerDispatch(dispatch.id)
  if (!worker) {
    return false
  }
  let effects: unknown
  try {
    effects = JSON.parse(worker.effects)
  } catch {
    return false
  }
  if (!Array.isArray(effects)) {
    return false
  }
  const terminal = effects.find(
    (effect) =>
      effect &&
      typeof effect === 'object' &&
      (effect as Record<string, unknown>).kind === 'terminal' &&
      (effect as Record<string, unknown>).role === 'agent'
  ) as Record<string, unknown> | undefined
  return terminal?.action === 'created'
}

/** An accepted terminal completion: the Dispatch settled succeeded AND a
 *  worker_done for it was not converted into a rejection. */
function acceptedCompletion(db: OrchestrationDb, dispatch: DispatchContextRow): boolean {
  if (dispatch.status !== 'completed' || !dispatch.completed_at) {
    return false
  }
  return completionMessages(db, dispatch).some((message) => !isRejection(message.payload))
}

function completionMessages(
  db: OrchestrationDb,
  dispatch: DispatchContextRow
): { payload: string | null }[] {
  return db
    .getRunMailboxHistory(dispatch.run_id, 200, ['worker_done'])
    .filter((message) => readPayloadDispatchId(message.payload) === dispatch.id)
}

function readPayloadDispatchId(payload: string | null): string | null {
  if (!payload) {
    return null
  }
  try {
    const parsed = JSON.parse(payload) as { dispatchId?: unknown }
    return typeof parsed.dispatchId === 'string' ? parsed.dispatchId : null
  } catch {
    return null
  }
}

function isRejection(payload: string | null): boolean {
  if (!payload) {
    return false
  }
  try {
    return '_orcaLifecycleRejection' in (JSON.parse(payload) as Record<string, unknown>)
  } catch {
    return false
  }
}

/** A real prevention event: a replayed or otherwise unauthorised completion for
 *  this Dispatch was rejected, or its capability was revoked at settlement. */
function duplicatePrevented(db: OrchestrationDb, dispatch: DispatchContextRow): boolean {
  return (
    Boolean(dispatch.capability_revoked_at) ||
    completionMessages(db, dispatch).some((message) => isRejection(message.payload))
  )
}

/** A real recovery transition: the Dispatch failed or was escalated for a
 *  liveness fault and the runtime recorded the transition. */
function recoveryTransition(db: OrchestrationDb, dispatch: DispatchContextRow): boolean {
  if (dispatch.status === 'failed' || dispatch.termination_reason) {
    return true
  }
  return db
    .getRunMailboxHistory(dispatch.run_id, 200, ['escalation'])
    .some((message) => readPayloadDispatchId(message.payload) === dispatch.id)
}

/** The role actually executed: a builder produced an accepted completion, a
 *  reviewer ran under a review phase bound to this Dispatch. */
function roleExecuted(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  role: 'builder' | 'reviewer'
): boolean {
  if (role === 'builder') {
    return acceptedCompletion(db, dispatch)
  }
  const rows = db.db
    .prepare(
      `SELECT count(*) AS n FROM control_plane_phase_launches
       WHERE dispatch_id = ? AND kind = 'review' AND state IN ('started', 'start_unknown')`
    )
    .get(dispatch.id) as { n: number } | undefined
  return (rows?.n ?? 0) > 0
}

export function observeCertificationEvidence(args: {
  db: OrchestrationDb
  source: CertificationObservationSource
  request: EvidenceObservationRequest
}): EvidenceObservation {
  const { db, source, request } = args
  const dispatch = db.getDispatchContextById(request.dispatchId)
  if (!dispatch?.process_incarnation) {
    return no('not_launched', `Dispatch ${request.dispatchId} never recorded a real launch.`)
  }

  switch (request.kind) {
    case 'fresh_launch':
    case 'retained_re_engagement': {
      const fresh = isFreshSession(db, dispatch)
      const wanted = request.kind === 'fresh_launch' ? 'fresh' : 'retained'
      if (request.sessionMode !== wanted || fresh !== (wanted === 'fresh')) {
        return no(
          'session_mode_mismatch',
          `Dispatch ${dispatch.id} ran a ${fresh ? 'fresh' : 'retained'} session; ${request.kind}/${request.sessionMode} does not describe it.`
        )
      }
      return ok(`Dispatch ${dispatch.id} ran a ${wanted} session.`)
    }

    case 'effective_model_identity':
    case 'effective_reasoning_mode': {
      const observed = source.observedEffectiveIdentity(dispatch.id)
      if (!observed) {
        return no(
          'effective_identity_unobservable',
          `No provider-observed effective identity for Dispatch ${dispatch.id}; a launch receipt that copies the request is not a receipt.`
        )
      }
      if (!sameRouteIdentity(observed, request.identity)) {
        return no(
          'effective_identity_mismatch',
          `Dispatch ${dispatch.id} is running a different route than claimed.`
        )
      }
      return ok(`Provider-observed identity matches the claimed route.`)
    }

    case 'pretool_acceptance': {
      const status = selectDispatchAgentStatus(dispatch, source.agentStatusSnapshot())
      if (!status?.toolName) {
        return no(
          'no_pretool_event',
          `No agent-hook tool event observed for Dispatch ${dispatch.id}.`
        )
      }
      return ok(`Agent-hook tool event observed (${status.toolName}).`)
    }

    case 'safe_launch_acceptance': {
      if (!dispatch.launch_token_hash) {
        return no(
          'no_safe_launch_token',
          `Dispatch ${dispatch.id} has no launch token, so the safe launcher did not admit it.`
        )
      }
      return ok('Safe launcher minted a launch token for this Dispatch.')
    }

    case 'task_dispatch_worktree_binding': {
      const worker = db.getWorkerDispatch(dispatch.id)
      if (!worker?.worktree_id || !dispatch.task_id) {
        return no(
          'no_worktree_binding',
          `Dispatch ${dispatch.id} is not bound to both a Task and a worktree.`
        )
      }
      return ok(`Bound to task ${dispatch.task_id} and worktree ${worker.worktree_id}.`)
    }

    case 'completion_receipt': {
      if (!acceptedCompletion(db, dispatch)) {
        return no(
          'no_accepted_completion',
          `Dispatch ${dispatch.id} has no accepted terminal completion.`
        )
      }
      return ok(`Accepted terminal completion recorded at ${dispatch.completed_at}.`)
    }

    case 'duplicate_prevention': {
      if (!duplicatePrevented(db, dispatch)) {
        return no(
          'no_duplicate_prevented',
          `Nothing was actually prevented for Dispatch ${dispatch.id}.`
        )
      }
      return ok('A replayed or unauthorised completion was rejected for this Dispatch.')
    }

    case 'failure_recovery': {
      if (!recoveryTransition(db, dispatch)) {
        return no(
          'no_recovery_transition',
          `Dispatch ${dispatch.id} never went through a recovery transition.`
        )
      }
      return ok('A real failure or recovery transition was recorded.')
    }

    case 'role_execution': {
      if (!roleExecuted(db, dispatch, request.role)) {
        return no(
          'role_did_not_execute',
          `Dispatch ${dispatch.id} never executed the ${request.role} role.`
        )
      }
      return ok(`The ${request.role} role executed on this Dispatch.`)
    }
  }
}

/** Reads the launch receipt's effective identity ONLY when it was independently
 *  observed. A receipt whose effective block is a copy of the request proves
 *  nothing about what the provider is running. */
export function readObservedLaunchIdentity(
  db: OrchestrationDb,
  dispatchId: string
): RouteIdentity | null {
  const receipt = readDispatchLaunchReceipt(db, dispatchId)
  return receipt?.effectiveProvenance === 'observed' ? receipt.effective : null
}
