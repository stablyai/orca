import type { OrchestrationDb } from '../../orchestration/db'
import {
  applyWaitForSetupOutcome,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

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
