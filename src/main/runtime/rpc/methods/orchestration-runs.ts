import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  assertCallerHandleMatchesEvidence,
  resolveOrchestrationCaller
} from './orchestration-run-scope'
import { isCurrentRunCoordinator } from '../../orchestration/run-coordinator-authority'
import { isEquivalentPaneKey } from '../../orchestration/db/pane-key-match'
import {
  isCallerCurrentRunCoordinator,
  resolveAttestedRunCoordinatorPane,
  resolveRunCoordinatorIdentity
} from './orchestration-coordinator-caller'
import { observeRunCoordinator } from './orchestration-run-coordinator-observation'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal')
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const identity = resolveRunCoordinatorIdentity(runtime, params.from, paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        coordinatorProcessIncarnation: identity.processIncarnation,
        coordinatorHostScope: identity.hostScope
      })
      runtime.cancelMessageWaiters(params.from)
      if (priorRun) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
    params: RunUseParams,
    handler: async (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: preflightCallerAuthority
      }
    ) => {
      let callerAuthority =
        preflightCallerAuthority ??
        runtime.verifyOrchestrationCompatibilityCaller(orchestrationCompatibilityEvidence) ??
        undefined
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireStablePane: true,
        evidenceAssertedByCaller: true
      })
      if (
        params.takeoverLegacy &&
        (callerAuthority?.terminalHandle !== params.from || callerAuthority.paneKey !== paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const db = runtime.getOrchestrationDb()
      const targetRun = db.getRun(params.id)
      const identity = resolveRunCoordinatorIdentity(runtime, params.from, paneKey)
      const incumbentIdentity =
        targetRun &&
        !targetRun.coordinator_process_incarnation &&
        targetRun.coordinator_handle &&
        targetRun.coordinator_handle !== params.from
          ? resolveRunCoordinatorIdentity(
              runtime,
              targetRun.coordinator_handle,
              targetRun.coordinator_pane_key
            )
          : null
      const dynamicProcessContinuity = Boolean(
        incumbentIdentity?.processIncarnation &&
        identity.processIncarnation &&
        incumbentIdentity.processIncarnation === identity.processIncarnation &&
        incumbentIdentity.hostScope === identity.hostScope
      )
      const persistedProcessContinuity = Boolean(
        targetRun?.coordinator_process_incarnation &&
        targetRun.coordinator_handle !== params.from &&
        targetRun.coordinator_process_incarnation === identity.processIncarnation &&
        targetRun.coordinator_host_scope === identity.hostScope
      )
      const sameProcessRemint = dynamicProcessContinuity || persistedProcessContinuity
      if (!callerAuthority && sameProcessRemint && orchestrationCompatibilityEvidence) {
        callerAuthority =
          runtime.verifyOrchestrationCompatibilityCaller(orchestrationCompatibilityEvidence, {
            currentRuntimeLaunchSufficient: true
          }) ?? undefined
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence, {
        callerAuthority,
        allowLegacyAuthority: Boolean(legacyCoordinatorAuthority)
      })
      const restoredMigratedContinuity = Boolean(
        targetRun &&
        targetRun.coordinator_authority_revision < 0 &&
        callerAuthority?.terminalProvenance === 'restored' &&
        callerAuthority.processIncarnation === identity.processIncarnation &&
        JSON.stringify(callerAuthority.hostScope) === identity.hostScope &&
        targetRun.coordinator_handle === params.from &&
        targetRun.coordinator_pane_key &&
        isEquivalentPaneKey(targetRun.coordinator_pane_key, paneKey)
      )
      const sameAuthority = targetRun
        ? isCurrentRunCoordinator(targetRun, identity) ||
          dynamicProcessContinuity ||
          restoredMigratedContinuity
        : false
      const incumbentObservation =
        targetRun && !sameAuthority
          ? await observeRunCoordinator(runtime, targetRun, incumbentIdentity)
          : undefined
      const currentPaneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireStablePane: true,
        evidenceAssertedByCaller: true
      })
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence, {
        callerAuthority,
        allowLegacyAuthority: Boolean(legacyCoordinatorAuthority)
      })
      const currentIdentity = resolveRunCoordinatorIdentity(runtime, params.from, currentPaneKey)
      const revalidatedCaller = orchestrationCompatibilityEvidence
        ? runtime.verifyOrchestrationCompatibilityCaller(
            orchestrationCompatibilityEvidence,
            params.takeoverLegacy || sameProcessRemint
              ? { currentRuntimeLaunchSufficient: true }
              : undefined
          )
        : null
      const restoredContinuityStillAttested =
        !restoredMigratedContinuity ||
        Boolean(
          revalidatedCaller?.terminalProvenance === 'restored' &&
          revalidatedCaller.terminalHandle === params.from &&
          revalidatedCaller.paneKey === paneKey &&
          revalidatedCaller.processIncarnation === currentIdentity.processIncarnation &&
          JSON.stringify(revalidatedCaller.hostScope) === currentIdentity.hostScope
        )
      const claimantStillLive = revalidatedCaller
        ? revalidatedCaller.terminalHandle === params.from && revalidatedCaller.paneKey === paneKey
        : legacyCoordinatorAuthority || !orchestrationCompatibilityEvidence
          ? runtime.getLiveTerminalPaneKey(params.from) === paneKey
          : false
      if (
        (incumbentObservation && !claimantStillLive) ||
        !restoredContinuityStillAttested ||
        currentPaneKey !== paneKey ||
        currentIdentity.processIncarnation !== identity.processIncarnation ||
        currentIdentity.hostScope !== identity.hostScope
      ) {
        const coordinatorStatus = incumbentObservation?.status === 'live' ? 'live' : 'unverifiable'
        throw new OrchestrationError(
          'consumer_fenced',
          'The claiming coordinator process changed while Run authority was being checked. No effects were applied.',
          {
            effectsApplied: false,
            coordinatorStatus,
            claimantStatus: 'changed',
            inspectCommandArgs: ['orchestration', 'run-show', '--id', params.id, '--json'],
            retryCommandArgs: ['orchestration', 'run-use', '--id', params.id, '--json'],
            nextSteps: [
              `Inspect current authority by running orchestration run-show --id ${params.id} --json with the same Orca CLI executable.`,
              coordinatorStatus === 'live'
                ? 'Continue from the owning coordinator; do not retry while it remains live.'
                : `From one stable replacement agent process, run orchestration run-use --id ${params.id} --json with that executable so Orca can re-prove the incumbent state.`
            ]
          }
        )
      }
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        coordinatorProcessIncarnation: identity.processIncarnation,
        coordinatorHostScope: identity.hostScope,
        authorityContinuity: sameProcessRemint || restoredMigratedContinuity,
        incumbentObservation,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const run = runtime.getOrchestrationDb().getCurrentRunForPane(paneKey)
      return {
        run: run && isCallerCurrentRunCoordinator(runtime, run, params.from, paneKey) ? run : null
      }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => runtime.getOrchestrationDb().listRuns(params)
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      const callerPaneKey = params.from
        ? resolveAttestedRunCoordinatorPane(
            runtime,
            run,
            params.from,
            orchestrationCompatibilityEvidence
          )
        : null
      return {
        run,
        binding: {
          currentConsumer: Boolean(
            params.from &&
            run.legacy === 0 &&
            callerPaneKey !== null &&
            db.getCurrentRunForPane(callerPaneKey)?.id === run.id
          )
        }
      }
    }
  })
]
