import type { RunRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import { findCallerWorkerDispatches, workerRunBindingRefusal } from './worker-run-binding'
import {
  mailboxAddressOf,
  runBoundToCoordinator,
  runCoordinatorKey,
  type OrchestrationCoordinatorKey
} from '../../orchestration-caller-identity'

export function bindRun(
  this: OrchestrationDb,
  params: {
    runId: string
    coordinatorHandle: string | null
    coordinatorPaneKey: string | null
    /** The coordinator's bare Orca session id when it is a structured session; see orca-session-address. */
    coordinatorOrcaSessionId?: OrcaSessionId | null
    takeoverLegacy?: boolean
    /** The user asked to replace a coordinator that is still open. */
    takeover?: boolean
    /**
     * What the RPC layer saw just before this call: the Run's coordinator then, and how a user
     * recognizes it when it was proven open. A binding that moved since is refused, never bound blindly.
     */
    probed?: { coordinator: OrchestrationCoordinatorKey; liveLabel: string | null }
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
    orcaSessionId: params.coordinatorOrcaSessionId ?? null
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRunRaw(params.runId)
    if (!run || run.legacy === 1) {
      this.db.exec('ROLLBACK')
      return undefined
    }
    const sameBinding = runBoundToCoordinator(run, coordinator)
    const explicitTakeover = params.takeover === true || params.takeoverLegacy === true
    // Why: before the legacy gate, so a worker never sees its --takeover-legacy recovery command.
    const workerRefusal = sameBinding
      ? null
      : workerRunBindingRefusal(this, coordinator, params.runId, {
          takeover: explicitTakeover,
          bind: true
        })
    if (workerRefusal) {
      throw workerRefusal
    }
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
      if (findCallerWorkerDispatches(this, coordinator).length > 0) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Run ${params.runId} still has active legacy work and this caller cannot bind it. Nothing changed.`,
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
    const probed = params.probed
    if (probed && !sameBinding && !provenLegacyBinding && !explicitTakeover) {
      if (!sameCoordinatorKey(runCoordinatorKey(run), probed.coordinator)) {
        throw new OrchestrationError(
          'run_binding_changed',
          `Run ${params.runId}'s coordinator changed while this command ran. Nothing changed; run the same command again.`,
          { effectsApplied: false, retryable: true }
        )
      }
      if (probed.liveLabel !== null) {
        throw runCoordinatorLiveError(
          params.runId,
          probed.liveLabel,
          findCallerWorkerDispatches(this, coordinator).length > 0
        )
      }
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
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(params.runId)
}

function sameCoordinatorKey(
  a: OrchestrationCoordinatorKey,
  b: OrchestrationCoordinatorKey
): boolean {
  return (
    a.terminalHandle === b.terminalHandle &&
    a.paneKey === b.paneKey &&
    a.orcaSessionId === b.orcaSessionId
  )
}

// No recoveryCommand on purpose: agents run those mechanically, and the flag must carry user intent.
function runCoordinatorLiveError(
  runId: string,
  label: string,
  worker: boolean
): OrchestrationError {
  const takeoverAdvice = worker
    ? ''
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
