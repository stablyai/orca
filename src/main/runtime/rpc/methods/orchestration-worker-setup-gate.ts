import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerEffect, WorkerSetupReceipt } from './orchestration-worker-topology'

export class WorkerSetupGateError extends Error {
  readonly failedStage: 'setup_start' | 'setup_wait'
  readonly setupReceipt: WorkerSetupReceipt

  constructor(
    failedStage: 'setup_start' | 'setup_wait',
    message: string,
    setupReceipt: WorkerSetupReceipt
  ) {
    super(message)
    this.name = 'WorkerSetupGateError'
    this.failedStage = failedStage
    this.setupReceipt = setupReceipt
  }
}

export function applyWaitForSetupOutcome(
  receipt: WorkerSetupReceipt,
  effects: WorkerEffect[],
  wait: { satisfied: boolean; status: string }
): void {
  if (receipt.startupPolicy !== 'wait-for-setup' || receipt.state !== 'running') {
    return
  }
  if (wait.satisfied) {
    receipt.state = 'succeeded'
  } else if (wait.status === 'exited') {
    receipt.state = 'failed'
  } else {
    return
  }
  const setupEffect = effects.find((effect) => effect.kind === 'setup')
  if (setupEffect) {
    setupEffect.state = receipt.state
  }
}

export async function waitForWorkerSetupGate(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  deadlineAt: string
  timeoutMs?: number
  setupTerminalHandle?: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): Promise<void> {
  const { setupReceipt, effects } = args
  if (setupReceipt.startupPolicy !== 'wait-for-setup') {
    return
  }
  if (setupReceipt.state === 'spawn_failed') {
    recordGatedSetupStage(args)
    throw new WorkerSetupGateError(
      'setup_start',
      'Setup terminal failed to start before the bounded worker launch.',
      setupReceipt
    )
  }
  if (setupReceipt.state !== 'running') {
    return
  }
  if (!args.setupTerminalHandle) {
    setupReceipt.state = 'spawn_failed'
    updateSetupEffect(effects, setupReceipt.state)
    recordGatedSetupStage(args)
    throw new WorkerSetupGateError(
      'setup_start',
      'Gated setup did not expose a setup terminal.',
      setupReceipt
    )
  }
  const remainingMs = Date.parse(args.deadlineAt) - Date.now()
  if (remainingMs <= 0) {
    throw new WorkerSetupGateError(
      'setup_wait',
      'The immutable worker deadline elapsed during setup.',
      setupReceipt
    )
  }
  let completion: { exitCode: number | null }
  try {
    completion = await args.runtime.waitForSetupTerminalCompletion(args.setupTerminalHandle, {
      timeoutMs: Math.min(args.timeoutMs ?? 60_000, remainingMs)
    })
  } catch (error) {
    recordGatedSetupStage(args)
    throw new WorkerSetupGateError(
      'setup_wait',
      error instanceof Error ? error.message : String(error),
      setupReceipt
    )
  }
  setupReceipt.state = completion.exitCode === 0 ? 'succeeded' : 'failed'
  updateSetupEffect(effects, setupReceipt.state)
  if (setupReceipt.state === 'failed') {
    recordGatedSetupStage(args)
    throw new WorkerSetupGateError(
      'setup_wait',
      'Setup failed before the bounded worker launch.',
      setupReceipt
    )
  }
}

function updateSetupEffect(effects: WorkerEffect[], state: WorkerSetupReceipt['state']): void {
  const setupEffect = effects.find((effect) => effect.kind === 'setup')
  if (setupEffect) {
    setupEffect.state = state
  }
}

function recordGatedSetupStage(
  args: Pick<
    Parameters<typeof waitForWorkerSetupGate>[0],
    'db' | 'dispatchId' | 'worktreeId' | 'setupReceipt' | 'effects'
  >
): void {
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'setup_observed',
    worktreeId: args.worktreeId,
    setupState: args.setupReceipt.state,
    effects: args.effects,
    residualResources: args.effects
  })
}

export function monitorWorkerSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setupReceipt.startupPolicy !== 'start-immediately' ||
    args.setupReceipt.state !== 'running'
  ) {
    return
  }
  // Why: setup is intentionally non-gating, but command completion remains durable evidence.
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const evidence = args.db.updateWorkerSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects: args.effects.map((effect) =>
          effect.kind === 'setup' ? { ...effect, state: setupState } : effect
        )
      })
      if (!evidence.changed) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Setup ${setupState} for worker ${args.dispatchId}`,
        type: 'status',
        priority: setupState === 'failed' ? 'high' : 'normal',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          setupState,
          terminalHandle: setupTerminal.id
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
}

function residualWorkerEffects(effects: WorkerEffect[]): WorkerEffect[] {
  return effects.filter(
    (effect) => effect.action?.startsWith('created') || effect.action === 'reused_agent_terminal'
  )
}

type WorkerSetupStageArgs = {
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  terminalHandle: string
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
}

export function persistWorkerReadinessStage(args: WorkerSetupStageArgs): void {
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_readying',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
}

export function persistGatedSetupSpawnFailure(args: WorkerSetupStageArgs): boolean {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'spawn_failed') {
    return false
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'setup_start',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
  return true
}

export function persistWorkerSetupWaitOutcome(
  args: WorkerSetupStageArgs & { wait: { satisfied: boolean; status: string } }
): void {
  applyWaitForSetupOutcome(args.setup, args.effects, args.wait)
  if (args.setup.startupPolicy !== 'wait-for-setup') {
    return
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: args.setup.state === 'failed' ? 'setup_failed' : 'setup_settled',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
}
