import type { TuiAgent } from '../../../../shared/types'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  createBoundedFederatedTerminal,
  type FederationEffect
} from './orchestration-federation-effects'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'
import { WorkerSetupGateError } from './orchestration-worker-setup-gate'
import {
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome,
  waitForFederatedSetupGate
} from './orchestration-federation-setup'
import { FederationAttachStartParams } from './orchestration-federation-start-schema'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'
import {
  prepareFederationAttachmentWorkerStart,
  resolveBoundedWorkerControls
} from './orchestration-worker-start-validation'

export const ORCHESTRATION_FEDERATION_ATTACH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationAttachStart',
    params: FederationAttachStartParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Federated worker attachment requires a durable retry request.'
        )
      }
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote worker requires an exact existing worktree or new-top-level.'
        )
      }
      const createsWorktree = params.worktree === 'new-top-level'
      const { agent, launch } = prepareFederationAttachmentWorkerStart({
        params,
        createsWorktree,
        runtime
      })
      const controls = resolveBoundedWorkerControls(params, agent as TuiAgent)
      if (Date.parse(params.deadlineAt) <= Date.now()) {
        throw new OrchestrationError(
          'runtime_budget_exhausted',
          'The immutable worker deadline elapsed before remote process creation.'
        )
      }
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo as string,
          existingPlacement: 'an exact existing folder workspace'
        })
      }

      const db = runtime.getOrchestrationDb()
      db.createRemoteDispatchAttachment({
        dispatchId: params.dispatchId,
        taskId: params.taskId,
        homePeerFingerprint: orchestrationMutation.callerFingerprint,
        protocolVersion: params.protocolVersion,
        runtimeEpoch: runtime.getRuntimeId(),
        deadlineAt: params.deadlineAt,
        maxRequests: params.maxRequests,
        mutationReceipt: orchestrationMutation
      })
      const effects: FederationEffect[] = []
      let failedStage = createsWorktree ? 'worktree_create' : 'worktree_resolve'
      let worktree
      let terminalHandle: string | undefined
      const setupSource = createsWorktree
        ? (params.setupSource ?? (params.setup ? 'explicit_request' : 'orchestration_default'))
        : 'existing_worktree'
      let setup: WorkerSetupReceipt = {
        requested: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        effective: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        source: setupSource,
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: createsWorktree ? 'not_configured' : 'not_applicable'
      }
      try {
        if (createsWorktree) {
          db.recordRemoteAttachmentStage({
            dispatchId: params.dispatchId,
            stage: 'worktree_creating'
          })
          const setupDecision = params.setup ?? 'run'
          const created = await runtime.createManagedWorktree({
            repoSelector: params.repo as string,
            name: params.name as string,
            baseBranch: params.baseBranch,
            displayName: params.displayName,
            comment: params.comment,
            // setupDecision runs setup without the legacy runHooks activation side effect.
            runHooks: false,
            setupDecision,
            awaitTerminalProvisioning: true,
            observeSetupCompletion: true,
            createdWithAgent: agent as TuiAgent,
            activate: false,
            lineage: { noParent: true }
          })
          worktree = created.worktree
          effects.push({
            kind: 'worktree',
            action: 'created_top_level',
            id: created.worktree.id
          })
          setup = {
            requested: setupDecision,
            effective: setupDecision,
            source: setupSource,
            hookFound: created.setupReceipt?.hookFound ?? false,
            startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
            state: created.setupReceipt?.state ?? 'not_configured'
          }
          const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
            includeVisualLayouts: false
          })
          appendFederationTerminalEffects(
            effects,
            listed.terminals,
            undefined,
            created.setupReceipt?.terminalHandle
          )
          appendFederationSetupEffect(effects, setup)
          db.recordRemoteAttachmentStage({
            dispatchId: params.dispatchId,
            stage: 'worktree_created',
            worktreeId: created.worktree.id,
            setupState: setup.state,
            effects,
            residualResources: effects
          })
          failedStage = 'setup_wait'
          await waitForFederatedSetupGate({
            runtime,
            db,
            dispatchId: params.dispatchId,
            worktreeId: created.worktree.id,
            deadlineAt: params.deadlineAt,
            timeoutMs: params.timeoutMs,
            setupTerminalHandle: created.setupReceipt?.terminalHandle,
            setup,
            effects
          })
          terminalHandle = await createBoundedFederatedTerminal({
            runtime,
            db,
            dispatchId: params.dispatchId,
            worktreeId: created.worktree.id,
            taskId: params.taskId,
            agent: agent as TuiAgent,
            ...(launch.preferences ? { launchPreferences: launch.preferences } : {}),
            deadlineAt: params.deadlineAt,
            maxRequests: params.maxRequests,
            effects
          })
        } else {
          worktree = await runtime.showManagedWorktree(params.worktree).catch(() => {
            throw new OrchestrationError(
              'worktree_not_found_on_server',
              `Worktree ${params.worktree} was not found on the selected worker server.`
            )
          })
          effects.push(
            { kind: 'worktree', action: 'reused', id: worktree.id },
            { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
          )
          failedStage = 'terminal_create'
          terminalHandle = await createBoundedFederatedTerminal({
            runtime,
            db,
            dispatchId: params.dispatchId,
            worktreeId: worktree.id,
            taskId: params.taskId,
            agent: agent as TuiAgent,
            ...(launch.preferences ? { launchPreferences: launch.preferences } : {}),
            deadlineAt: params.deadlineAt,
            maxRequests: params.maxRequests,
            effects
          })
        }
        if (!worktree || !terminalHandle) {
          throw new Error('Federated worker topology did not resolve.')
        }
        const paneKey = runtime.getTerminalPaneKey(terminalHandle)
        const processIncarnation = runtime.getTerminalProcessIncarnation(terminalHandle)
        if (!paneKey || !processIncarnation) {
          throw new Error('stable_pane_required')
        }
        const capability = db.prepareRemoteAttachmentAuthority({
          dispatchId: params.dispatchId,
          paneKey,
          processIncarnation,
          worktreeId: worktree.id,
          terminalHandle,
          setupState: setup.state,
          effects
        })
        const setupStage = {
          db,
          dispatchId: params.dispatchId,
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          effects
        }
        if (persistFederatedSetupSpawnFailure(setupStage)) {
          failedStage = 'setup_start'
          throw new Error('Setup terminal failed to start before the gated agent launch.')
        }
        persistFederatedReadinessStage(setupStage)
        failedStage = 'agent_readiness'
        const wait = await runtime.waitForTerminal(terminalHandle, {
          condition: 'tui-idle',
          timeoutMs: params.timeoutMs ?? 60_000
        })
        persistFederatedSetupWaitOutcome({ ...setupStage, wait })
        if (!wait.satisfied) {
          if (setup.state === 'failed') {
            failedStage = 'setup_wait'
          }
          throw new Error(
            wait.blockedReason
              ? `Agent startup blocked: ${wait.blockedReason}`
              : `Agent did not become ready (${wait.status}).`
          )
        }
        failedStage = 'dispatch_input'
        await runtime.sendTerminalAgentPrompt(
          terminalHandle,
          buildDispatchPreamble({
            taskId: params.taskId,
            dispatchId: params.dispatchId,
            taskSpec: params.taskSpec,
            coordinatorHandle: 'Run home (relayed by Orca)',
            workerHandle: terminalHandle,
            maxRequests: params.maxRequests,
            dispatchCapability: capability,
            devMode: params.devMode,
            cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
          })
        )
        effects.push({
          kind: 'dispatch_input',
          role: 'agent',
          id: terminalHandle,
          state: 'accepted'
        })
        const attachment = db.markRemoteAttachmentReady(params.dispatchId, effects)
        monitorFederatedSetup({ ...setupStage, runtime })
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          stage: attachment.stage,
          runtimeEpoch: runtime.getRuntimeId(),
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          launch: launch.receipt,
          deadlineAt: params.deadlineAt,
          budget: controls.budget,
          leafControl: controls.leafControl,
          effects,
          residualResources: []
        }
      } catch (error) {
        if (error instanceof WorkerSetupGateError) {
          failedStage = error.failedStage
        }
        return failFederatedAttachmentWithReceipt({
          db,
          dispatchId: params.dispatchId,
          runtimeEpoch: runtime.getRuntimeId(),
          failedStage,
          error,
          setup,
          launch: launch.receipt
        })
      }
    }
  })
]
