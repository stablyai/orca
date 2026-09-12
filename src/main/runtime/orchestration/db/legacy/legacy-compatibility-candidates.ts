import type {
  DispatchContextRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function resolveLegacyCompatibilityPrincipalByIdentity(
  this: OrchestrationDb,
  params: {
    runId: string
    role: LegacyPrincipalRole
    terminalHandle?: string
    paneKey?: string
  }
): LegacyCompatibilityPrincipalRow | undefined {
  if (!params.terminalHandle && !params.paneKey) {
    return undefined
  }
  const rows = (
    this.db
      .prepare(
        `SELECT * FROM legacy_compatibility_principals
         WHERE run_id = ? AND role = ? AND status IN ('committed', 'settled')
         ORDER BY rowid`
      )
      .all(params.runId, params.role) as LegacyCompatibilityPrincipalRow[]
  ).filter((principal) =>
    params.paneKey
      ? isEquivalentPaneKey(principal.pane_key, params.paneKey)
      : principal.terminal_handle === params.terminalHandle
  )
  if (rows.length > 1) {
    throw new OrchestrationError(
      'operation_unknown',
      'Multiple legacy principals match this process identity.'
    )
  }
  return rows[0]
}

export function resolveLegacyWorkerCandidate(
  this: OrchestrationDb,
  params: {
    runId?: string
    terminalHandle?: string
    paneKey?: string
    dispatchId?: string
    taskId?: string
  }
): { dispatch: DispatchContextRow } | undefined {
  if (!params.runId || (!params.terminalHandle && !params.paneKey)) {
    return undefined
  }
  const rows = (
    params.dispatchId
      ? [this.getDispatchContextById(params.dispatchId)].filter(
          (row): row is DispatchContextRow => row !== undefined
        )
      : (this.db
          .prepare(
            `SELECT * FROM dispatch_contexts
             WHERE run_id = ? AND contract_version = ?
               AND status IN ('pending', 'dispatched')
             ORDER BY rowid`
          )
          .all(params.runId, LEGACY_CONTRACT_VERSION) as DispatchContextRow[])
  ).filter(
    (dispatch) =>
      dispatch.run_id === params.runId &&
      dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
      (!params.taskId || dispatch.task_id === params.taskId) &&
      (params.paneKey
        ? Boolean(
            dispatch.assignee_pane_key &&
            isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
          )
        : dispatch.assignee_handle === params.terminalHandle)
  )
  if (rows.length > 1) {
    throw new OrchestrationError(
      'operation_unknown',
      'Multiple active legacy Dispatches match this process identity.'
    )
  }
  if (params.dispatchId && rows.length === 0) {
    const target = this.getDispatchContextById(params.dispatchId)
    if (target?.contract_version === LEGACY_CONTRACT_VERSION) {
      throw new OrchestrationError(
        'legacy_read_only',
        `Dispatch ${params.dispatchId} is retained but this process cannot prove ownership.`
      )
    }
  }
  return rows[0] ? { dispatch: rows[0] } : undefined
}

export function resolveLegacyCoordinatorCandidate(
  this: OrchestrationDb,
  params: {
    runId: string
    terminalHandle?: string
    paneKey?: string
  }
): { terminalHandle: string; paneKey: string } | undefined {
  if (!params.terminalHandle || !params.paneKey) {
    return undefined
  }
  const run = this.getRunRaw(params.runId)
  const principal = this.getLegacyCoordinatorPrincipal(params.runId)
  if (principal) {
    if (
      principal.status !== 'committed' ||
      principal.terminal_handle !== params.terminalHandle ||
      !isEquivalentPaneKey(principal.pane_key, params.paneKey) ||
      (run?.coordinator_pane_key !== null &&
        (run?.coordinator_handle !== principal.terminal_handle ||
          !isEquivalentPaneKey(run.coordinator_pane_key, principal.pane_key)))
    ) {
      return undefined
    }
    return { terminalHandle: params.terminalHandle, paneKey: params.paneKey }
  }
  // Why: the first current binding durably fences uncommitted legacy processes.
  if (
    !run ||
    run.coordinator_pane_key !== null ||
    this.getUniqueLegacyCoordinatorHandle(params.runId) !== params.terminalHandle
  ) {
    return undefined
  }
  return { terminalHandle: params.terminalHandle, paneKey: params.paneKey }
}

// Why: caller-side fence jurisdiction. Widening this fences more callers, so keep it narrow.
export function isLegacyCoordinatorHandle(
  this: OrchestrationDb,
  runId: string,
  terminalHandle: string
): boolean {
  const principal = this.getLegacyCoordinatorPrincipal(runId)
  if (principal) {
    return principal.terminal_handle === terminalHandle
  }
  return this.getUniqueLegacyCoordinatorHandle(runId) === terminalHandle
}

// Why: recipient-side permit for legacy lifecycle mail. After a takeover revokes the old principal
// the replacement coordinator is only reachable through the Run binding.
export function isLegacyCoordinatorDeliveryTarget(
  this: OrchestrationDb,
  runId: string,
  terminalHandle: string
): boolean {
  if (this.isLegacyCoordinatorHandle(runId, terminalHandle)) {
    return true
  }
  if (this.getRunRaw(runId)?.coordinator_handle !== terminalHandle) {
    return false
  }
  // Why: must match resolveLegacyWorkerCoordinatorDelivery's takeover test. A still-committed
  // principal routes legacy_direct to this handle, and no reader can see that mailbox.
  return this.getLegacyCoordinatorPrincipal(runId)?.status !== 'committed'
}

export type LegacyCompatibilityCandidatesMethods = {
  resolveLegacyCompatibilityPrincipalByIdentity: typeof resolveLegacyCompatibilityPrincipalByIdentity
  resolveLegacyWorkerCandidate: typeof resolveLegacyWorkerCandidate
  resolveLegacyCoordinatorCandidate: typeof resolveLegacyCoordinatorCandidate
  isLegacyCoordinatorHandle: typeof isLegacyCoordinatorHandle
  isLegacyCoordinatorDeliveryTarget: typeof isLegacyCoordinatorDeliveryTarget
}

export function attachLegacyCompatibilityCandidates(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    resolveLegacyCompatibilityPrincipalByIdentity,
    resolveLegacyWorkerCandidate,
    resolveLegacyCoordinatorCandidate,
    isLegacyCoordinatorHandle,
    isLegacyCoordinatorDeliveryTarget
  })
}
