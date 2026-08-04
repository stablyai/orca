import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './orchestration-federation-effects'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'
import {
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome
} from './orchestration-federation-setup'
import { FederationAttachStartParams } from './orchestration-federation-start-schema'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'

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
      if (createsWorktree && (!params.name || !params.repo)) {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote new-top-level worktree requires --name and an explicit --repo.'
        )
      }
      if (createsWorktree && params.terminal) {
        throw new OrchestrationError(
          'invalid_argument',
          '--terminal cannot combine with remote new-worktree creation.'
        )
      }
      if (
        !createsWorktree &&
        (params.name || params.repo || params.baseBranch || params.setup || params.setupSource)
      ) {
        throw new OrchestrationError(
          'invalid_argument',
          'Creation and setup options apply only to remote new-top-level worktrees.'
        )
      }
      if (params.terminal && params.agent) {
        throw new OrchestrationError(
          'invalid_argument',
          '--terminal reuses an existing agent and cannot combine with --agent.'
        )
      }
      const agent = params.agent
      if (!params.terminal && (!agent || !isTuiAgent(agent))) {
        throw new OrchestrationError(
          'agent_unconfigured',
          'A configured --agent is required when federated worker-start creates a terminal.'
        )
      }
      if (agent) {
        runtime.validateOrchestrationAgentLauncher(agent as TuiAgent)
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
        mutationReceipt: orchestrationMutation
      })
      const effects: FederationEffect[] = []
      let failedStage = createsWorktree ? 'worktree_create' : 'worktree_resolve'
      let worktree
      let terminalHandle = params.terminal
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
            startupAgent: agent as TuiAgent,
            activate: false,
            lineage: { noParent: true }
          })
          worktree = created.worktree
          terminalHandle = created.startupTerminal?.handle
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
          if (!terminalHandle) {
            throw new Error(
              created.warning ?? 'Agent-first worktree creation returned no terminal.'
            )
          }
          const listed = await runtime.listTerminals(`id:${created.worktree.id}`)
          appendFederationTerminalEffects(
            effects,
            listed.terminals,
            terminalHandle,
            created.setupReceipt?.terminalHandle
          )
          appendFederationSetupEffect(effects, setup)
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
          if (terminalHandle) {
            const terminal = await runtime.showTerminal(terminalHandle)
            if (terminal.worktreeId !== worktree.id) {
              throw new OrchestrationError(
                'terminal_worktree_mismatch',
                `Terminal ${terminalHandle} does not belong to worktree ${worktree.id}.`
              )
            }
            if (!(await runtime.isTerminalRunningAgent(terminalHandle))) {
              throw new OrchestrationError(
                'agent_unconfigured',
                `Terminal ${terminalHandle} is not running a recognized agent.`
              )
            }
            effects.push({
              kind: 'terminal',
              role: 'agent',
              action: 'reused',
              id: terminalHandle
            })
          } else {
            failedStage = 'terminal_create'
            const terminal = await runtime.createTerminal(`id:${worktree.id}`, {
              // Why: agent ids are not shell commands (`cursor` is the desktop app,
              // its CLI is `cursor-agent`); resolve through the TUI agent config.
              startupAgent: agent as TuiAgent,
              title: `worker-${params.taskId}`,
              presentation: 'background'
            })
            terminalHandle = terminal.handle
            effects.push({
              kind: 'terminal',
              role: 'agent',
              action: 'created',
              id: terminal.handle
            })
          }
        }
        if (!worktree || !terminalHandle) {
          throw new Error('Federated worker topology did not resolve.')
        }
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
        failedStage = 'dispatch_input'
        await runtime.sendTerminalAgentPrompt(
          terminalHandle,
          buildDispatchPreamble({
            taskId: params.taskId,
            dispatchId: params.dispatchId,
            taskSpec: params.taskSpec,
            coordinatorHandle: 'Run home (relayed by Orca)',
            workerHandle: terminalHandle,
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
          effects,
          residualResources: []
        }
      } catch (error) {
        return failFederatedAttachmentWithReceipt({
          db,
          dispatchId: params.dispatchId,
          runtimeEpoch: runtime.getRuntimeId(),
          failedStage,
          error,
          setup
        })
      }
    }
  })
]
