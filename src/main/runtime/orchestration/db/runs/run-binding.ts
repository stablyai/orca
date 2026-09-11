import type { RunRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { isEquivalentPaneKey } from '../pane-key-match'
import { isEquivalentPrincipal } from '../principal-match'
import type { OrchestrationDb } from '../orchestration-db'
import { runCoordinatorBinding, type RunCoordinatorParam } from './run-coordinator-binding'

export function bindRun(
  this: OrchestrationDb,
  params: {
    runId: string
    takeoverLegacy?: boolean
    legacyCoordinatorAuthority?: {
      runId: string
      principalId: string | null
      terminalHandle: string
      paneKey: string
      consumerGeneration: number
    }
  } & RunCoordinatorParam
): RunRow | undefined {
  const coordinator = runCoordinatorBinding(params)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRunRaw(params.runId)
    if (!run || run.legacy === 1) {
      this.db.exec('ROLLBACK')
      return undefined
    }
    const sameBinding =
      run.coordinator_principal !== null &&
      isEquivalentPrincipal(run.coordinator_principal, coordinator.principalId)
    const adoption = this.getLegacyAdoption()
    const adoptedRun = adoption?.adopted_run_id === params.runId
    const legacyAuthority = params.legacyCoordinatorAuthority
    const legacyPrincipalId = legacyAuthority?.principalId
    const legacyPrincipal = legacyPrincipalId
      ? this.getLegacyCompatibilityPrincipal(legacyPrincipalId)
      : undefined
    // Why: a null handle or pane key never proves — a session binding yields false, matching today.
    const provenLegacyBinding = Boolean(
      adoptedRun &&
      legacyAuthority &&
      legacyAuthority.principalId !== null &&
      legacyAuthority.runId === params.runId &&
      legacyAuthority.consumerGeneration === run.consumer_generation &&
      legacyPrincipal?.run_id === params.runId &&
      legacyPrincipal.role === 'coordinator' &&
      legacyPrincipal.status === 'committed' &&
      legacyPrincipal.terminal_handle === legacyAuthority.terminalHandle &&
      isEquivalentPaneKey(legacyPrincipal.pane_key, legacyAuthority.paneKey) &&
      coordinator.terminalHandle === legacyAuthority.terminalHandle &&
      coordinator.paneKey !== null &&
      isEquivalentPaneKey(coordinator.paneKey, legacyAuthority.paneKey)
    )
    if (legacyAuthority && !provenLegacyBinding) {
      throw new OrchestrationError(
        'legacy_read_only',
        'This retained legacy coordinator no longer has lifecycle authority. No effects were applied.',
        { effectsApplied: false }
      )
    }
    const activeLegacyAssignment =
      adoptedRun &&
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM dispatch_contexts
             WHERE run_id = ? AND contract_version = ?
               AND status IN ('pending', 'dispatched')
             LIMIT 1`
          )
          .get(params.runId, LEGACY_CONTRACT_VERSION)
      )
    const coordinatorPrincipal = adoptedRun
      ? this.getLegacyCoordinatorPrincipal(params.runId)
      : undefined
    const retainedCoordinatorHandle =
      coordinatorPrincipal?.terminal_handle ??
      run.coordinator_handle ??
      this.getUniqueLegacyCoordinatorHandle(params.runId)
    const takeoverAlreadyApplied = Boolean(
      params.takeoverLegacy &&
      sameBinding &&
      coordinator.terminalHandle !== null &&
      run.coordinator_handle === coordinator.terminalHandle &&
      coordinatorPrincipal?.status !== 'committed'
    )
    const replacesLegacyCoordinator = Boolean(
      adoptedRun &&
      !provenLegacyBinding &&
      retainedCoordinatorHandle &&
      (params.takeoverLegacy ||
        retainedCoordinatorHandle !== coordinator.terminalHandle ||
        !sameBinding)
    )
    if (params.takeoverLegacy && !adoptedRun) {
      throw new OrchestrationError(
        'invalid_argument',
        'Legacy takeover is only available for the automatically adopted Run.'
      )
    }
    // Why: only LIVE legacy work needs the flag — settled work has no competing authority left, and
    // fencing it would strand the recovered graph behind an attestation the caller may not have.
    if (activeLegacyAssignment && !sameBinding && !provenLegacyBinding && !params.takeoverLegacy) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This adopted Run still has live legacy work. Its attested coordinator may rebind it, or a current coordinator may explicitly use run-use --takeover-legacy.',
        {
          effectsApplied: false,
          recoveryCommand: `orca orchestration run-use --id ${params.runId} --takeover-legacy`
        }
      )
    }
    this.unbindOtherRunsForPrincipal(coordinator.principalId, params.runId)
    for (const handle of new Set(
      [run.coordinator_handle, coordinator.terminalHandle].filter((value): value is string =>
        Boolean(value)
      )
    )) {
      this.rememberRunCoordinatorHandle(params.runId, handle)
      this.routeAllUnreadDirectMessagesToRunMailbox(params.runId, handle)
    }
    if (
      (params.takeoverLegacy && !takeoverAlreadyApplied) ||
      !sameBinding ||
      run.coordinator_handle !== coordinator.terminalHandle
    ) {
      if (adoptedRun && (params.takeoverLegacy || !activeLegacyAssignment)) {
        if (
          coordinatorPrincipal?.status === 'committed' &&
          (params.takeoverLegacy ||
            coordinatorPrincipal.terminal_handle !== coordinator.terminalHandle ||
            coordinator.paneKey === null ||
            !isEquivalentPaneKey(coordinatorPrincipal.pane_key, coordinator.paneKey))
        ) {
          this.setLegacyCompatibilityPrincipalStatus(coordinatorPrincipal.id, 'revoked')
        }
      }
      this.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = ?, coordinator_pane_key = ?, coordinator_principal = ?,
               consumer_generation = consumer_generation + 1,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(coordinator.terminalHandle, coordinator.paneKey, coordinator.principalId, params.runId)
      this.fenceOutstandingDelivery(params.runId)
      if (params.takeoverLegacy || replacesLegacyCoordinator) {
        this.promoteLegacyCoordinatorMailForTakeover(params.runId, retainedCoordinatorHandle)
      }
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(params.runId)
}

export type RunBindingMethods = {
  bindRun: typeof bindRun
}

export function attachRunBinding(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    bindRun
  })
}
