import { authorizeRunBinding, acceptRunHandover } from './run-ownership'
import { getRunAuthority, getRunHandover, recordRunCaller } from './run-authority-store'
import type { RunRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import {
  mailboxAddressOf,
  runBoundToCoordinator,
  runCoordinatorKey
} from '../../orchestration-caller-identity'

export function bindRun(
  this: OrchestrationDb,
  params: {
    processIncarnation?: string | null
    recordReceipt?: (run: RunRow) => void
    onUnchangedWorker?: () => void
    takeover?: boolean
    probed?: { consumerGeneration: number; liveLabel: string | null }
    runId: string
    coordinatorHandle: string | null
    coordinatorPaneKey: string | null
    /** The coordinator's bare Orca session id when it is a structured session; see orca-session-address. */
    coordinatorOrcaSessionId?: OrcaSessionId | null
    takeoverLegacy?: boolean
    legacyCoordinatorAuthority?: {
      runId: string
      principalId: string | null
      terminalHandle: string
      paneKey: string
      consumerGeneration: number
    }
  }
): RunRow | undefined {
  const coordinator = {
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey,
    orcaSessionId: params.coordinatorOrcaSessionId ?? null,
    processIncarnation: params.processIncarnation ?? null
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRunRaw(params.runId)
    if (!run || run.legacy === 1) {
      this.db.exec('ROLLBACK')
      return undefined
    }
    const decision = authorizeRunBinding(
      this,
      run,
      coordinator,
      Boolean(params.takeover || params.takeoverLegacy)
    )
    const sameBinding = decision.worker
      ? decision.unchanged
      : runBoundToCoordinator(run, coordinator)
    const adoption = this.getLegacyAdoption()
    const adoptedRun = adoption?.adopted_run_id === params.runId
    const legacyAuthority = params.legacyCoordinatorAuthority
    const legacyPrincipalId = legacyAuthority?.principalId
    const legacyPrincipal = legacyPrincipalId
      ? this.getLegacyCompatibilityPrincipal(legacyPrincipalId)
      : undefined
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
      params.coordinatorHandle === legacyAuthority.terminalHandle &&
      params.coordinatorPaneKey !== null &&
      isEquivalentPaneKey(params.coordinatorPaneKey, legacyAuthority.paneKey)
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
      run.coordinator_handle === params.coordinatorHandle &&
      coordinatorPrincipal?.status !== 'committed'
    )
    const replacesLegacyCoordinator = Boolean(
      adoptedRun &&
      !provenLegacyBinding &&
      retainedCoordinatorHandle &&
      (params.takeoverLegacy ||
        retainedCoordinatorHandle !== params.coordinatorHandle ||
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
      if (decision.worker) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This Run still has active legacy work. Ask its coordinator for recovery; nothing changed.',
          { effectsApplied: false }
        )
      }
      throw new OrchestrationError(
        'consumer_fenced',
        'This adopted Run still has live legacy work. Its attested coordinator may rebind it, or a current coordinator may explicitly use run-use --takeover-legacy.',
        {
          effectsApplied: false,
          recoveryCommand: `orca orchestration run-use --id ${params.runId} --takeover-legacy`
        }
      )
    }
    if (params.probed && params.probed.consumerGeneration !== run.consumer_generation) {
      throw new OrchestrationError(
        'run_binding_changed',
        'The Run’s coordinator changed while it was checked. Retry the same command.',
        { effectsApplied: false, retryable: true, runId: params.runId }
      )
    }
    if (decision.worker && decision.unchanged) {
      const confirmed = this.getRun(params.runId)
      if (!confirmed) {
        throw new Error('Confirmed Run is missing')
      }
      params.recordReceipt?.(confirmed)
      params.onUnchangedWorker?.()
      this.db.exec('COMMIT')
      return confirmed
    }
    if (
      !sameBinding &&
      params.probed?.liveLabel &&
      !decision.grantAccepted &&
      !decision.priorAttempt &&
      !params.takeover &&
      !params.takeoverLegacy &&
      !provenLegacyBinding
    ) {
      throw runCoordinatorLiveError(params.runId, params.probed.liveLabel, decision.worker)
    }
    const priorAuthority = getRunAuthority(this, params.runId)
    const priorHandover = decision.grantAccepted ? undefined : getRunHandover(this, params.runId)
    if (decision.grantAccepted) {
      acceptRunHandover(this, params.runId)
    }
    this.unbindOtherRunsForCoordinator(coordinator, params.runId)
    // The mailbox address of the coordinator being replaced and of the one binding now.
    for (const address of new Set([
      mailboxAddressOf(runCoordinatorKey(run)),
      mailboxAddressOf(coordinator)
    ])) {
      if (address === null) {
        continue
      }
      this.rememberRunCoordinatorHandle(params.runId, address)
      this.routeAllUnreadDirectMessagesToRunMailbox(params.runId, address)
    }
    if (
      (params.takeoverLegacy && !takeoverAlreadyApplied) ||
      !sameBinding ||
      run.coordinator_handle !== params.coordinatorHandle
    ) {
      if (adoptedRun && (params.takeoverLegacy || !activeLegacyAssignment)) {
        if (
          coordinatorPrincipal?.status === 'committed' &&
          (params.takeoverLegacy ||
            coordinatorPrincipal.terminal_handle !== params.coordinatorHandle ||
            params.coordinatorPaneKey === null ||
            !isEquivalentPaneKey(coordinatorPrincipal.pane_key, params.coordinatorPaneKey))
        ) {
          this.setLegacyCompatibilityPrincipalStatus(coordinatorPrincipal.id, 'revoked')
        }
      }
      this.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = ?, coordinator_pane_key = ?, coordinator_orca_session_id = ?,
               coordinator_orca_session_id_generation = consumer_generation + 1,
               consumer_generation = consumer_generation + 1,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          coordinator.terminalHandle,
          coordinator.paneKey,
          coordinator.orcaSessionId,
          params.runId
        )
      this.fenceUnacknowledgedMailboxDeliveries(`run:${params.runId}`)
      if (params.takeoverLegacy || replacesLegacyCoordinator) {
        this.promoteLegacyCoordinatorMailForTakeover(params.runId, retainedCoordinatorHandle)
      }
    } else if (runCoordinatorKey(run).orcaSessionId !== coordinator.orcaSessionId) {
      // Same coordinator, so no new consumer: correct an Orca session id a writer without the column left.
      this.db
        .prepare(
          `UPDATE runs SET coordinator_orca_session_id = ?,
             coordinator_orca_session_id_generation = consumer_generation
           WHERE id = ?`
        )
        .run(coordinator.orcaSessionId, params.runId)
    }
    recordRunCaller(this, params.runId, coordinator, priorAuthority, priorHandover)
    const bound = this.getRun(params.runId)
    if (!bound) {
      throw new Error('Bound Run is missing')
    }
    params.recordReceipt?.(bound)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(params.runId)
}

// No recoveryCommand on purpose: agents run those mechanically, and the flag must carry user intent.
function runCoordinatorLiveError(
  runId: string,
  label: string,
  worker: boolean
): OrchestrationError {
  const takeoverAdvice = worker
    ? ' Ask its coordinator for a hand-over with run-handover.'
    : ` Take it over only if the user asks: orca orchestration run-use --id ${runId} --takeover replaces it, and its unacknowledged mail is replayed to you.`
  return new OrchestrationError(
    'run_coordinator_live',
    `Run ${runId} is coordinated by ${label}, which is still open. Nothing changed. Closing it clears this.${takeoverAdvice}`,
    { effectsApplied: false, runId, coordinator: label }
  )
}

export type RunBindingMethods = {
  bindRun: typeof bindRun
}

export function attachRunBinding(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    bindRun
  })
}
