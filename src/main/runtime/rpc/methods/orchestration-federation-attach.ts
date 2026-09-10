import { createHash } from 'node:crypto'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { FederationEffect } from './orchestration/federation/federation-effects'
import type { WorkerSetupReceipt } from './orchestration/worker/worker-topology'
import {
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome
} from './orchestration/federation/federation-setup'
import { failFederatedAttachmentWithReceipt } from './orchestration/federation/federation-start-receipt'
import { prepareFederationAttachmentWorkerStart } from './orchestration/worker/worker-start-validation'
import { attachWorkerLaunchExecutable } from './orchestration/worker/worker-launch-preferences'
import { assertFederationAttachmentRequest } from './orchestration-federation-attach-request'
import type { FederationAttachStartInput } from './orchestration/federation/federation-start-schema'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { provisionFederatedWorkerWorkspace } from './orchestration-federation-provision'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './orchestration/worker/worker-start-prompt-budget'
import {
  prepareFederatedAttachmentRuntime,
  type OrchestrationMutation
} from './orchestration-federation-attach-runtime'

type AttachArgs = {
  params: FederationAttachStartInput
  runtime: OrcaRuntimeService
  orchestrationMutation: OrchestrationMutation | undefined
}

/** Attaches one federated worker: reserve the lease, provision, launch, settle or fail closed. */
export async function attachFederatedWorker({
  params,
  runtime,
  orchestrationMutation
}: AttachArgs) {
  assertFederationAttachmentRequest(params, orchestrationMutation)
  await assertWorkerStartTaskSpecWithinPromptBudget(params.taskSpec)
  const createsWorktree = params.worktree === 'new-top-level'
  const { agent, launch } = prepareFederationAttachmentWorkerStart({
    params,
    createsWorktree,
    runtime
  })
  const { attemptBound, db, leaseTitle, preflightExecutable, runId, workerLease } =
    await prepareFederatedAttachmentRuntime({
      params,
      runtime,
      orchestrationMutation,
      createsWorktree,
      agent,
      launch
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
    const provisioned = await provisionFederatedWorkerWorkspace({
      params,
      runtime,
      db,
      createsWorktree,
      agent,
      launch,
      leaseTitle,
      effects,
      setup,
      setupSource,
      terminalHandle,
      setStage: (stage) => {
        failedStage = stage
      }
    })
    worktree = provisioned.worktree
    terminalHandle = provisioned.terminalHandle
    setup = provisioned.setup
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
      effects,
      terminalOwnership: params.terminal ? 'external' : 'created'
    })
    failedStage = 'dispatch_input'
    if (!attemptBound || !workerLease) {
      // Why: a negotiated-down peer has no lease and no managed-CLI contract to
      // prove, so its preamble is delivered directly, exactly as protocol 1 to 3
      // always did. Nothing here claims an identity the peer never sent.
      const send = await runtime.sendTerminalAgentPrompt(
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
        }),
        { acceptQueued: true, observationTimeoutMs: 0, requestId: params.dispatchId }
      )
      if (send && send.accepted === false) {
        throw new Error('dispatch_input_delivery_unknown')
      }
    } else {
      runtime.assertTerminalManagedCliAvailable(terminalHandle)
      {
        const managedCliContext = runtime.buildTerminalManagedCliContext(terminalHandle)
        if (managedCliContext.executable !== preflightExecutable) {
          throw new Error('managed_cli_profile_drift')
        }
        attachWorkerLaunchExecutable(launch.receipt, managedCliContext.executable)
        const terminal = await runtime.showTerminal(terminalHandle)
        const tabId = terminal.tabId ?? paneKey.slice(0, paneKey.indexOf(':'))
        db.attachMaestroTerminalLease({
          leaseId: workerLease.id,
          terminalHandle,
          tabId,
          paneKey,
          ptyIncarnation: processIncarnation,
          processRootId: terminal.ptyId ?? null,
          executionHostId: managedCliContext.executionHostId,
          workspaceKey: managedCliContext.workspaceKey
        })
        db.transitionMaestroTerminalLease({ leaseId: workerLease.id, state: 'ready' })
        const preamble = buildDispatchPreamble({
          taskId: params.taskId,
          dispatchId: params.dispatchId,
          taskSpec: params.taskSpec,
          coordinatorHandle: 'Run home (relayed by Orca)',
          workerHandle: terminalHandle,
          dispatchCapability: capability,
          devMode: params.devMode,
          cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle),
          managedCliContext,
          requiresManagedCliContext: true
        })
        const commandId = `federated:${params.dispatchId}:preamble`
        const inputAcceptance = db.acceptMaestroTerminalInput({
          commandId,
          idempotencyKey: `federated:${params.dispatchId}:preamble`,
          contentDigest: `sha256:${createHash('sha256').update(preamble).digest('hex')}`,
          enqueueSequence: 1,
          sender: {
            principalId: orchestrationMutation.callerFingerprint,
            authority: 'coordinator',
            runId,
            coordinatorGeneration: attemptBound.coordinatorGeneration
          },
          leaseId: workerLease.id,
          executionHostId: managedCliContext.executionHostId,
          workspaceKey: managedCliContext.workspaceKey,
          terminalHandle,
          tabId,
          ptyIncarnation: processIncarnation,
          expectedLifecycleState: 'ready',
          observedInputSurface: 'ready_prompt',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedGraphRevision: null
        })
        if (inputAcceptance.replayed && inputAcceptance.receipt.state === 'accepted') {
          db.transitionMaestroTerminalInput({
            commandId: inputAcceptance.receipt.commandId,
            state: 'delivery_unknown',
            rejectionCode: 'delivery_interrupted_before_receipt'
          })
          throw new Error('federated_preamble_delivery_unknown')
        }
        if (!inputAcceptance.replayed) {
          const send = await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
            acceptQueued: true,
            observationTimeoutMs: 0,
            requestId: params.dispatchId
          })
          db.transitionMaestroTerminalInput({
            commandId: inputAcceptance.receipt.commandId,
            state: send.accepted ? 'written_to_pty' : 'delivery_unknown',
            bytesWritten: send.bytesWritten,
            enterWritten: send.accepted
          })
          if (!send.accepted) {
            throw new Error('dispatch_input_delivery_unknown')
          }
        } else if (
          inputAcceptance.receipt.state !== 'written_to_pty' &&
          inputAcceptance.receipt.state !== 'acknowledged'
        ) {
          throw new Error(`federated_preamble_${inputAcceptance.receipt.state}`)
        }
        db.transitionMaestroTerminalLease({ leaseId: workerLease.id, state: 'active' })
      }
    }
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
      paneKey,
      processIncarnation,
      setup,
      launch: launch.receipt,
      effects,
      residualResources: []
    }
  } catch (error) {
    const lease = workerLease ? db.getMaestroTerminalLease(workerLease.id) : null
    if (
      workerLease &&
      lease &&
      !['released', 'archived', 'retained'].includes(lease.lifecycleState)
    ) {
      db.retainMaestroTerminalLease(workerLease.id)
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
