import type { RunRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isCurrentRunCoordinator } from '../../run-coordinator-authority'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export type RunCoordinatorObservation = {
  coordinatorHandle: string | null
  coordinatorPaneKey: string | null
  coordinatorProcessIncarnation: string | null
  coordinatorHostScope: string | null
  status: 'live' | 'unverifiable' | 'exited'
}

export function bindRun(
  this: OrchestrationDb,
  params: {
    runId: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    coordinatorProcessIncarnation?: string | null
    coordinatorHostScope?: string | null
    authorityContinuity?: boolean
    incumbentObservation?: RunCoordinatorObservation
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
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRunRaw(params.runId)
    if (!run || run.legacy === 1) {
      this.db.exec('ROLLBACK')
      return undefined
    }
    const sameBinding =
      run.coordinator_pane_key !== null &&
      isEquivalentPaneKey(run.coordinator_pane_key, params.coordinatorPaneKey)
    const sameAuthority =
      params.authorityContinuity === true ||
      isCurrentRunCoordinator(run, {
        handle: params.coordinatorHandle,
        paneKey: params.coordinatorPaneKey,
        processIncarnation: params.coordinatorProcessIncarnation ?? null,
        hostScope: params.coordinatorHostScope ?? null
      })
    const adoption = this.getLegacyAdoption()
    const adoptedRun = adoption?.adopted_run_id === params.runId
    const observation = params.incumbentObservation
    const observationMatches =
      observation?.coordinatorHandle === run.coordinator_handle &&
      observation.coordinatorPaneKey === run.coordinator_pane_key &&
      observation.coordinatorProcessIncarnation === run.coordinator_process_incarnation &&
      observation.coordinatorHostScope === run.coordinator_host_scope
    const hasIncumbentAuthority = Boolean(
      run.coordinator_handle ||
      run.coordinator_pane_key ||
      run.coordinator_process_incarnation ||
      run.coordinator_host_scope
    )
    const requiresAuthorityProof = hasIncumbentAuthority
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
    const appliesLegacyTakeover = Boolean(
      params.takeoverLegacy &&
      (coordinatorPrincipal?.status === 'committed' || !hasIncumbentAuthority)
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
    if (activeLegacyAssignment && !sameBinding && !provenLegacyBinding && !appliesLegacyTakeover) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This adopted Run still has live legacy work. Its attested coordinator may rebind it, or a current coordinator may explicitly use run-use --takeover-legacy.',
        {
          effectsApplied: false,
          recoveryCommand: `orca orchestration run-use --id ${params.runId} --takeover-legacy`
        }
      )
    }
    if (
      requiresAuthorityProof &&
      !sameAuthority &&
      !provenLegacyBinding &&
      !appliesLegacyTakeover &&
      (!observationMatches || observation.status !== 'exited')
    ) {
      const coordinatorStatus = observationMatches ? observation.status : 'unverifiable'
      const inspectCommand = `orchestration run-show --id ${params.runId} --json`
      const retryCommand = `orchestration run-use --id ${params.runId} --json`
      const nextSteps =
        coordinatorStatus === 'live'
          ? [
              'Continue from the owning coordinator terminal; this caller has read-only inspection authority.',
              `To intentionally transfer authority, stop or exit that coordinator process, then run ${retryCommand} with the same Orca CLI executable from the replacement.`,
              `Inspect current authority by running ${inspectCommand} with the same Orca CLI executable; binding.currentConsumer is true only for the owner.`,
              'Do not retry while coordinatorStatus is live. No force-steal exists for an ordinary Run.'
            ]
          : [
              'Restore connectivity to the owning host. Loss of contact is not evidence of exit.',
              `Inspect current authority by running ${inspectCommand} with the same Orca CLI executable; binding.currentConsumer is true only for the owner.`,
              `Run ${retryCommand} with that executable only after the owning host proves the incumbent exited.`,
              'If the incumbent is live, continue from its coordinator terminal; no force-steal exists for an ordinary Run.'
            ]
      throw new OrchestrationError(
        'consumer_fenced',
        coordinatorStatus === 'live'
          ? 'This Run is owned by another live coordinator. No effects were applied.'
          : 'This Run coordinator could not be proven exited. Retry from the owning coordinator terminal after connectivity is restored. No effects were applied.',
        {
          effectsApplied: false,
          coordinatorStatus,
          inspectCommandArgs: ['orchestration', 'run-show', '--id', params.runId, '--json'],
          retryCommandArgs: ['orchestration', 'run-use', '--id', params.runId, '--json'],
          nextSteps
        }
      )
    }
    this.unbindOtherRunsForPane(
      params.coordinatorPaneKey,
      {
        handle: params.coordinatorHandle,
        paneKey: params.coordinatorPaneKey,
        processIncarnation: params.coordinatorProcessIncarnation ?? null,
        hostScope: params.coordinatorHostScope ?? null
      },
      params.runId
    )
    for (const handle of new Set(
      [run.coordinator_handle, params.coordinatorHandle].filter((value): value is string =>
        Boolean(value)
      )
    )) {
      this.rememberRunCoordinatorHandle(params.runId, handle)
      this.routeAllUnreadDirectMessagesToRunMailbox(params.runId, handle)
    }
    const bindingMetadataChanged =
      !sameBinding ||
      run.coordinator_handle !== params.coordinatorHandle ||
      run.coordinator_process_incarnation !== (params.coordinatorProcessIncarnation ?? null) ||
      run.coordinator_host_scope !== (params.coordinatorHostScope ?? null)
    if ((appliesLegacyTakeover && !takeoverAlreadyApplied) || bindingMetadataChanged) {
      if (adoptedRun && (appliesLegacyTakeover || !activeLegacyAssignment)) {
        if (
          coordinatorPrincipal?.status === 'committed' &&
          (appliesLegacyTakeover ||
            coordinatorPrincipal.terminal_handle !== params.coordinatorHandle ||
            !isEquivalentPaneKey(coordinatorPrincipal.pane_key, params.coordinatorPaneKey))
        ) {
          this.setLegacyCompatibilityPrincipalStatus(coordinatorPrincipal.id, 'revoked')
        }
      }
      const changesAuthority = !sameAuthority || appliesLegacyTakeover
      this.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = ?, coordinator_pane_key = ?,
               coordinator_process_incarnation = ?, coordinator_host_scope = ?,
               coordinator_authority_revision = coordinator_authority_revision + 1,
               consumer_generation = consumer_generation + ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          params.coordinatorHandle,
          params.coordinatorPaneKey,
          params.coordinatorProcessIncarnation ?? null,
          params.coordinatorHostScope ?? null,
          changesAuthority ? 1 : 0,
          params.runId
        )
      if (changesAuthority) {
        this.fenceOutstandingDelivery(params.runId)
      }
      if (appliesLegacyTakeover || replacesLegacyCoordinator) {
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
