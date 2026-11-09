import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal/runtime-policy/terminal-wait-blocked-reason-legacy-alias'
import { buildDispatchPreamble } from '../../../../orchestration/workers/launch/worker-dispatch-preamble'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { assertOrchestrationWorktreeCreationSupported } from '../worker/folder-worktree-placement'
import { isFederationEffectUnknown, type FederationEffect } from './federation-effects'
import { launchFederatedWorkerAgent } from './federated-worker-agent-launch'
import {
  federatedSetupSource,
  initialFederatedSetup,
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome
} from './federation-setup'
import { FederationAttachStartParams } from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
import { failFederatedAttachmentWithReceipt } from './federation-start-receipt'
import { prepareFederationWorkerLaunchOnHost } from '../worker/worker-opencode-model-preflight'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration/orchestration-timing-budgets'
import { assertWorkerStartTaskSpecWithinPromptBudget } from '../worker/worker-start-prompt-budget'
import { prepareFederatedAttachmentAuthority } from './federation-attachment-authority'
import { resolveRpcWorkspaceCreatorProvenance } from '../../../workspace-creator-context'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings,
  resolveWorkerStartModeOnHost
} from '../structured-workers/orchestration-worker-start-mode'
import { tearDownFailedWorkerStart } from '../worker/failed-worker-start-teardown'
import {
  awaitFederatedWorkerReady,
  federatedWorkerAddress,
  sendFederatedWorkerBrief,
  type StructuredSession
} from './federated-worker-brief'
import { ORCHESTRATION_FEDERATION_CHAT_WORKERS_PROTOCOL_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { claimTerminalForRemoteAttach } from '../../../../orchestration/db/worker-dispatch/worker-terminal-claim'

export const ORCHESTRATION_FEDERATION_ATTACH_METHODS = [
  defineMethod({
    name: 'orchestration.federationAttachStart',
    requires: ['accounts'],
    permission: 'workspace',
    params: FederationAttachStartParams,
    handler: async (params, context) => {
      const { runtime, orchestrationMutation } = context
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Federated worker attachment requires a durable retry request.'
        )
      }
      await assertWorkerStartTaskSpecWithinPromptBudget(params.taskSpec)
      if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
        throw new OrchestrationError(
          'invalid_argument',
          '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote worker requires an exact existing worktree or new-top-level.'
        )
      }
      const createsWorktree = params.worktree === 'new-top-level'
      const { agent, launch } = await prepareFederationWorkerLaunchOnHost({
        params,
        createsWorktree,
        runtime
      })
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo as string,
          existingPlacement: 'an exact existing folder workspace'
        })
      }

      const db = runtime.getOrchestrationDb()
      // Synchronous through the insert, so a racing start on the same terminal is refused before any wait.
      const releaseTerminalClaim = claimTerminalForRemoteAttach(db, params.terminal, runtime, {
        dispatchId: params.dispatchId,
        taskId: params.taskId
      })
      try {
        db.createRemoteDispatchAttachment({
          runId: params.runId,
          dispatchId: params.dispatchId,
          taskId: params.taskId,
          homePeerFingerprint: orchestrationMutation.callerFingerprint,
          protocolVersion: params.protocolVersion,
          runtimeEpoch: runtime.getRuntimeId(),
          depth: params.depth,
          mutationReceipt: orchestrationMutation
        })
      } catch (error) {
        releaseTerminalClaim()
        throw error
      }
      const effects: FederationEffect[] = []
      let failedStage = createsWorktree ? 'worktree_create' : 'worktree_resolve'
      let worktree
      let terminalHandle = params.terminal
      let terminalCreation: RuntimeTerminalCreate | undefined
      let structuredSession: StructuredSession | null = null
      // This host decides chat or terminal from its own settings, as a local start does; a home too old
      // to know a chat worker gets the terminal it expects.
      let mode = decideWorkerStartMode({
        params: { agent, terminal: params.terminal, worktree: params.worktree },
        settings: readWorkerStartModeSettings(runtime),
        terminalOnly:
          params.protocolVersion < ORCHESTRATION_FEDERATION_CHAT_WORKERS_PROTOCOL_VERSION
      })
      const setupSource = federatedSetupSource(params, createsWorktree)
      let setup = initialFederatedSetup(params, createsWorktree, setupSource)
      try {
        const launchAgent = (existing?: { id: string }) =>
          launchFederatedWorkerAgent({
            runtime,
            db,
            params,
            agent,
            launchPreferences: launch.preferences,
            mode,
            ...(existing
              ? { worktree: existing }
              : { creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context) }),
            setupSource,
            effects,
            onSetup: (created) => {
              setup = created
            },
            onStage: (stage) => {
              failedStage = stage
            }
          })
        if (createsWorktree) {
          ;({ worktree, terminalHandle, terminalCreation, structuredSession, mode } =
            await launchAgent())
        } else {
          worktree = await runtime.showManagedTerminalWorkspace(params.worktree).catch(() => {
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
            mode = await resolveWorkerStartModeOnHost(runtime, mode, worktree.id, agent)
            ;({ terminalHandle, terminalCreation, structuredSession, mode } =
              await launchAgent(worktree))
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
        const wait = await awaitFederatedWorkerReady({
          runtime,
          structuredSession,
          terminalHandle,
          agent,
          reusesTerminal: Boolean(params.terminal),
          creation: terminalCreation,
          setup,
          effects,
          timeoutMs: readinessTimeoutMs
        })
        if (wait) {
          persistFederatedSetupWaitOutcome({ ...setupStage, wait })
        }
        if (wait && !wait.satisfied) {
          if (setup.state === 'failed') {
            failedStage = 'setup_wait'
          }
          throw new Error(
            wait.blockedReason
              ? `Agent startup blocked: ${describeTerminalWaitBlockedReason(wait.blockedReason)}`
              : `Agent did not become ready (${wait.status}).`
          )
        }
        prepareFederatedAttachmentAuthority({
          runtime,
          db,
          dispatchId: params.dispatchId,
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          effects,
          reusesTerminal: Boolean(params.terminal),
          ...(structuredSession ? { identity: structuredSession.identity } : {})
        })
        failedStage = 'dispatch_input'
        const preamble = buildDispatchPreamble({
          taskId: params.taskId,
          dispatchId: params.dispatchId,
          taskSpec: params.taskSpec,
          coordinatorHandle: 'Run home (relayed by Orca)',
          workerHandle: federatedWorkerAddress(structuredSession, terminalHandle),
          devMode: params.devMode,
          // Enforce the execution host's nesting cap using its own setting.
          canDispatchSubWorkers: (params.depth ?? 1) < runtime.getNestedWorkerMaxDepth(),
          subWorkersInOwnRun: true,
          cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
        })
        const prompt = await sendFederatedWorkerBrief({
          runtime,
          structuredSession,
          terminalHandle,
          agent,
          params,
          operationId: orchestrationMutation.requestId,
          preamble,
          budgetMs: readinessTimeoutMs
        })
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
          mode,
          effects,
          ...(prompt?.prompt ? { prompt: prompt.prompt } : {}),
          residualResources: []
        }
      } catch (error) {
        // A chat that may hold its brief stays for the worker to report; a refused start retires it.
        if (structuredSession && !isFederationEffectUnknown(error, failedStage)) {
          await tearDownFailedWorkerStart({
            runtime,
            structuredSession,
            dispatchId: params.dispatchId,
            error
          })
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
      } finally {
        releaseTerminalClaim()
      }
    }
  })
]
