import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import {
  resolveWorkerResumeCheckpoint,
  type WorkerResumeCheckpoint
} from '../../orchestration/worker-session-resume'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { createWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import { persistWorkerReadinessStage } from './orchestration-worker-setup-gate'
import {
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

const RESUME_SETUP: WorkerSetupReceipt = {
  requested: 'not_applicable',
  effective: 'not_applicable',
  source: 'resumed_provider_session',
  hookFound: false,
  startupPolicy: 'start-immediately',
  state: 'not_applicable'
}

export async function startLocalResumedWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: { id: string; spec: string }
  orchestrationMutation?: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
}): Promise<unknown> {
  const { params, runtime, db, runId, task, orchestrationMutation } = args
  assertResumeOptions(params)
  const checkpoint = resolveWorkerResumeCheckpoint({
    db,
    sourceDispatchId: params.resumeDispatch as string
  })
  await assertResumeWorktree(runtime, checkpoint)

  const launch = createWorkerLaunchReceipt({ agent: checkpoint.agent })
  const started = db.createStartingWorkerDispatch({
    taskId: task.id,
    retryOf: params.retryOf,
    resumeSourceDispatchId: checkpoint.sourceDispatchId,
    claimResumeCheckpoint: true,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation,
    startOptions: {
      worktree: `id:${checkpoint.worktreeId}`,
      resolvedWorktreeId: checkpoint.worktreeId,
      resumeDispatch: checkpoint.sourceDispatchId,
      agent: checkpoint.agent,
      launch,
      timeoutMs: params.timeoutMs ?? 60_000,
      setup: 'not_applicable',
      setupSource: 'resumed_provider_session'
    }
  })
  const effects: WorkerEffect[] = [
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
    effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'resumed',
      id: terminalHandle,
      surface: ensured.terminal.surface
    })
    persistWorkerReadinessStage({
      db,
      dispatchId: started.dispatch.id,
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
      JSON.stringify(authority?.hostScope) !== checkpoint.hostScope
    ) {
      throw new OrchestrationError(
        'resume_ownership_mismatch',
        'The resumed terminal does not match the checkpoint worktree and execution host.'
      )
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: checkpoint.worktreeId,
      effects,
      setupState: RESUME_SETUP.state,
      terminalOwnership: 'created'
    })

    failedStage = 'dispatch_input'
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: started.dispatch.id,
      resumedFromDispatchId: checkpoint.sourceDispatchId,
      taskSpec: task.spec,
      coordinatorHandle: params.from,
      workerHandle: terminalHandle,
      dispatchCapability: capability,
      devMode: params.devMode,
      cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
    })
    await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'accepted'
    })
    const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
    return {
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      setup: RESUME_SETUP,
      launch,
      timeoutMs: params.timeoutMs ?? 60_000,
      effects,
      residualResources: []
    }
  } catch (error) {
    return failWorkerStartWithReceipt({
      db,
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: RESUME_SETUP,
      launch
    })
  }
}

function assertResumeOptions(params: WorkerStartInput): void {
  const conflicting = [
    params.on,
    params.worktree,
    params.name,
    params.repo,
    params.baseBranch,
    params.displayName,
    params.comment,
    params.setup,
    params.terminal,
    params.agent,
    params.model,
    params.effort
  ]
  if (conflicting.some((value) => value !== undefined)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--resume-dispatch cannot combine with placement, creation, terminal, agent, model, or effort options.'
    )
  }
}

async function assertResumeWorktree(
  runtime: OrcaRuntimeService,
  checkpoint: WorkerResumeCheckpoint
): Promise<void> {
  let worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  let hostScope: Awaited<ReturnType<OrcaRuntimeService['getOrchestrationWorkspaceHostScope']>>
  try {
    worktree = await runtime.showManagedTerminalWorkspace(`id:${checkpoint.worktreeId}`)
    hostScope = await runtime.getOrchestrationWorkspaceHostScope(`id:${checkpoint.worktreeId}`)
  } catch {
    throw new OrchestrationError(
      'resume_worktree_unavailable',
      'The provider session owning worktree is not available on this execution host.'
    )
  }
  if (worktree.id !== checkpoint.worktreeId) {
    throw new OrchestrationError(
      'resume_worktree_unavailable',
      'The provider session owning worktree is not available on this execution host.'
    )
  }
  if (JSON.stringify(hostScope) !== checkpoint.hostScope) {
    throw new OrchestrationError(
      'resume_host_mismatch',
      'The provider session checkpoint belongs to a different execution host.'
    )
  }
}
