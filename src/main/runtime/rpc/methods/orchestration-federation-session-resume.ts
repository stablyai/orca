import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveRemoteWorkerResumeCheckpoint } from '../../orchestration/worker-session-resume'
import type { FederationEffect } from './orchestration-federation-effects'
import { persistFederatedReadinessStage } from './orchestration-federation-setup'
import type { FederationAttachStartInput } from './orchestration-federation-start-schema'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'
import { createWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'

const RESUME_SETUP: WorkerSetupReceipt = {
  requested: 'not_applicable',
  effective: 'not_applicable',
  source: 'resumed_provider_session',
  hookFound: false,
  startupPolicy: 'start-immediately',
  state: 'not_applicable'
}

export async function startResumedFederationAttachment(args: {
  params: FederationAttachStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  orchestrationMutation: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
}): Promise<unknown> {
  const { params, runtime, db, orchestrationMutation } = args
  assertResumeAttachmentOptions(params)
  const checkpoint = resolveRemoteWorkerResumeCheckpoint({
    db,
    sourceDispatchId: params.resumeDispatch as string
  })
  const source = db.getRemoteDispatchAttachment(checkpoint.sourceDispatchId)
  if (!source?.terminal_handle) {
    throw new OrchestrationError(
      'resume_checkpoint_mismatch',
      'The source worker terminal identity is unavailable.'
    )
  }
  const sourceActive = await runtime
    .isTerminalRunningAgent(source.terminal_handle)
    .catch(() => false)
  if (sourceActive) {
    throw new OrchestrationError(
      'resume_source_active',
      `Remote worker Dispatch ${checkpoint.sourceDispatchId} still has a live agent terminal.`
    )
  }
  const worktree = await runtime
    .showManagedTerminalWorkspace(`id:${checkpoint.worktreeId}`)
    .catch(() => {
      throw new OrchestrationError(
        'resume_worktree_unavailable',
        'The provider session owning worktree is unavailable on this worker server.'
      )
    })
  const hostScope = await runtime.getOrchestrationWorkspaceHostScope(`id:${checkpoint.worktreeId}`)
  if (
    worktree.id !== checkpoint.worktreeId ||
    params.worktree !== `id:${checkpoint.worktreeId}` ||
    JSON.stringify(hostScope) !== checkpoint.hostScope
  ) {
    throw new OrchestrationError(
      'resume_ownership_mismatch',
      'The requested remote worktree does not match the provider session checkpoint.'
    )
  }

  const launch = createWorkerLaunchReceipt({ agent: checkpoint.agent })
  db.createRemoteDispatchAttachment({
    dispatchId: params.dispatchId,
    taskId: params.taskId,
    homePeerFingerprint: orchestrationMutation.callerFingerprint,
    protocolVersion: params.protocolVersion,
    runtimeEpoch: runtime.getRuntimeId(),
    resumeSourceDispatchId: checkpoint.sourceDispatchId,
    mutationReceipt: orchestrationMutation
  })
  const effects: FederationEffect[] = [
    { kind: 'worktree', action: 'reused', id: checkpoint.worktreeId },
    { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
  ]
  let failedStage = 'agent_resume'
  try {
    const ensured = await runtime.ensureAgentSession({
      kind: 'explicit',
      worktree: `id:${checkpoint.worktreeId}`,
      agent: checkpoint.agent,
      providerSession: checkpoint.providerSession,
      presentation: 'background'
    })
    if (ensured.disposition !== 'created') {
      throw new OrchestrationError(
        'resume_session_conflict',
        'The provider session is already owned by another live terminal.'
      )
    }
    const terminalHandle = ensured.terminal.handle
    effects.push({ kind: 'terminal', role: 'agent', action: 'resumed', id: terminalHandle })
    persistFederatedReadinessStage({
      db,
      dispatchId: params.dispatchId,
      worktreeId: checkpoint.worktreeId,
      terminalHandle,
      setup: RESUME_SETUP,
      effects
    })

    failedStage = 'agent_readiness'
    const wait = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: params.timeoutMs ?? 60_000
    })
    if (!wait.satisfied) {
      throw new Error(
        wait.blockedReason
          ? `Agent resume blocked: ${wait.blockedReason}`
          : `Resumed agent did not become ready (${wait.status}).`
      )
    }
    const terminal = await runtime.showTerminal(terminalHandle)
    const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
    if (
      terminal.worktreeId !== checkpoint.worktreeId ||
      JSON.stringify(authority?.hostScope) !== checkpoint.hostScope ||
      !authority?.paneKey ||
      !authority.processIncarnation
    ) {
      throw new OrchestrationError(
        'resume_ownership_mismatch',
        'The resumed terminal does not match the checkpoint worktree and execution host.'
      )
    }
    const capability = db.prepareRemoteAttachmentAuthority({
      dispatchId: params.dispatchId,
      paneKey: authority.paneKey,
      processIncarnation: authority.processIncarnation,
      worktreeId: checkpoint.worktreeId,
      terminalHandle,
      setupState: RESUME_SETUP.state,
      effects
    })

    failedStage = 'dispatch_input'
    await runtime.sendTerminalAgentPrompt(
      terminalHandle,
      buildDispatchPreamble({
        taskId: params.taskId,
        dispatchId: params.dispatchId,
        resumedFromDispatchId: checkpoint.sourceDispatchId,
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
    return {
      dispatchId: params.dispatchId,
      state: attachment.state,
      stage: attachment.stage,
      runtimeEpoch: runtime.getRuntimeId(),
      worktreeId: checkpoint.worktreeId,
      terminalHandle,
      setup: RESUME_SETUP,
      launch,
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
      setup: RESUME_SETUP,
      launch
    })
  }
}

function assertResumeAttachmentOptions(params: FederationAttachStartInput): void {
  const conflicting = [
    params.name,
    params.repo,
    params.baseBranch,
    params.displayName,
    params.comment,
    params.setup,
    params.setupSource,
    params.terminal,
    params.agent,
    params.model,
    params.effort
  ]
  if (conflicting.some((value) => value !== undefined)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A native resume attachment cannot combine with creation, terminal, agent, model, or effort options.'
    )
  }
}
