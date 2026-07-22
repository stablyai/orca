/**
 * ORCH-R15 role lease / post-worker_done quarantine.
 *
 * Decision:
 * - Derive worker + quarantine from dispatch_contexts (pane-aware).
 * - Persist only explicit coordinator grants in role_leases (ceremony=explicit_handoff).
 * - Guard coordinator control RPCs fail-closed before mutation.
 *
 * Integration: #9904 (semantic completion) — quarantine follows any inactive
 * dispatch outcome; no completion-path edits. #9916 (handle rebind) — shares
 * pane-equivalent assignee lookup; does not change rebind writes. #9920 — no overlap.
 */
import type { OrchestrationDb } from './db'
import type { DispatchContextRow, RoleLeaseRow } from './types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

export type OrchestrationCallerIdentity = {
  handle?: string | null
  paneKey?: string | null
}

export type OrchestrationAuthority =
  | { role: 'unscoped' }
  | { role: 'worker'; dispatch: DispatchContextRow }
  | { role: 'quarantined'; lastDispatch: DispatchContextRow }
  | { role: 'coordinator'; lease: RoleLeaseRow }

export type CoordinatorControlOperation =
  | 'taskCreate'
  | 'taskUpdate'
  | 'dispatch'
  | 'reset'
  | 'run'
  | 'runStop'
  | 'gateCreate'
  | 'gateResolve'
  | 'ask'
  | 'send.decision_gate'
  | 'send.handoff'
  | 'send.dispatch'
  | 'send.merge_ready'
  | 'roleLeaseGrant'

export class OrchestrationRoleDeniedError extends Error {
  readonly code = 'orchestration_role_denied' as const
  readonly operation: CoordinatorControlOperation
  readonly authority: OrchestrationAuthority

  constructor(operation: CoordinatorControlOperation, authority: OrchestrationAuthority) {
    super(formatRoleDeniedMessage(operation, authority))
    this.name = 'OrchestrationRoleDeniedError'
    this.operation = operation
    this.authority = authority
  }
}

function isEquivalentPaneKey(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  const aLeaf = parsePaneKey(a)?.leafId
  const bLeaf = parsePaneKey(b)?.leafId
  return Boolean(aLeaf && bLeaf && aLeaf === bLeaf)
}

export function matchesAssigneeIdentity(
  row: { assignee_handle: string | null; assignee_pane_key: string | null },
  identity: OrchestrationCallerIdentity
): boolean {
  const handle = identity.handle?.trim() || undefined
  const paneKey = identity.paneKey?.trim() || undefined
  if (handle && row.assignee_handle === handle) {
    return true
  }
  if (paneKey && row.assignee_pane_key && isEquivalentPaneKey(row.assignee_pane_key, paneKey)) {
    return true
  }
  return false
}

export function matchesLeaseSubject(
  lease: RoleLeaseRow,
  identity: OrchestrationCallerIdentity
): boolean {
  const handle = identity.handle?.trim() || undefined
  const paneKey = identity.paneKey?.trim() || undefined
  if (handle && lease.subject_handle === handle) {
    return true
  }
  if (paneKey && lease.subject_pane_key && isEquivalentPaneKey(lease.subject_pane_key, paneKey)) {
    return true
  }
  return false
}

/**
 * Resolve machine-verifiable orchestration authority for a caller.
 *
 * Precedence:
 * 1. active worker dispatch (pane/handle) → worker-scoped
 * 2. active coordinator role lease → coordinator
 * 3. prior inactive worker dispatch → post-worker_done quarantine
 * 4. otherwise → unscoped (may perform coordinator control)
 *
 * Missing caller identity stays unscoped so external/non-terminal owners keep
 * recovery tools; the ORCH-R15 failure mode always has a live worker identity.
 */
export function resolveOrchestrationAuthority(
  db: OrchestrationDb,
  identity: OrchestrationCallerIdentity
): OrchestrationAuthority {
  const handle = identity.handle?.trim() || undefined
  const paneKey = identity.paneKey?.trim() || undefined
  if (!handle && !paneKey) {
    return { role: 'unscoped' }
  }

  const active = db.findActiveDispatchForAssignee(handle ?? '', paneKey)
  if (active && matchesAssigneeIdentity(active, { handle, paneKey })) {
    return { role: 'worker', dispatch: active }
  }

  const lease = db.findActiveCoordinatorLease({ handle, paneKey })
  if (lease) {
    return { role: 'coordinator', lease }
  }

  const latest = db.findLatestDispatchForAssignee({ handle, paneKey })
  if (
    latest &&
    matchesAssigneeIdentity(latest, { handle, paneKey }) &&
    latest.status !== 'pending' &&
    latest.status !== 'dispatched'
  ) {
    return { role: 'quarantined', lastDispatch: latest }
  }

  return { role: 'unscoped' }
}

export function canPerformCoordinatorControl(
  authority: OrchestrationAuthority,
  operation: CoordinatorControlOperation
): boolean {
  switch (authority.role) {
    case 'unscoped':
    case 'coordinator':
      return true
    case 'worker':
      // Active workers may ask / open a decision_gate toward their coordinator.
      return operation === 'ask' || operation === 'send.decision_gate'
    case 'quarantined':
      return false
  }
}

export function assertCoordinatorControlAllowed(
  db: OrchestrationDb,
  identity: OrchestrationCallerIdentity,
  operation: CoordinatorControlOperation
): OrchestrationAuthority {
  const authority = resolveOrchestrationAuthority(db, identity)
  if (!canPerformCoordinatorControl(authority, operation)) {
    throw new OrchestrationRoleDeniedError(operation, authority)
  }
  return authority
}

export function formatRoleDeniedMessage(
  operation: CoordinatorControlOperation,
  authority: OrchestrationAuthority
): string {
  if (authority.role === 'worker') {
    return (
      `Denied ${operation}: terminal is an active dispatched worker ` +
      `(${authority.dispatch.id} / task ${authority.dispatch.task_id}). ` +
      `Stay worker-scoped; coordinator control requires a fresh role lease after this dispatch ends.`
    )
  }
  if (authority.role === 'quarantined') {
    return (
      `Denied ${operation}: terminal is post-worker_done quarantined ` +
      `(last dispatch ${authority.lastDispatch.id}). ` +
      `Ordinary user text is not a coordinator promotion. ` +
      `Re-dispatch with a fresh preamble, or grant an explicit coordinator role lease.`
    )
  }
  return `Denied ${operation}: orchestration role does not allow coordinator control.`
}

export function coordinatorControlOpForMessageType(
  type: string | undefined
): CoordinatorControlOperation | null {
  switch (type) {
    case 'decision_gate':
      return 'send.decision_gate'
    case 'handoff':
      return 'send.handoff'
    case 'dispatch':
      return 'send.dispatch'
    case 'merge_ready':
      return 'send.merge_ready'
    default:
      return null
  }
}
