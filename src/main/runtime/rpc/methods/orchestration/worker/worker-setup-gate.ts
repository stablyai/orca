import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  applyWaitForSetupOutcome,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'

function residualWorkerEffects(effects: WorkerEffect[]): WorkerEffect[] {
  // 'reused_agent_terminal' is the retired verb agent-first creation used for its own agent
  // terminal; rows persisted before the rename still carry it.
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

/**
 * What a launched brief's turn start may still wait: the agent's launch, any setup it waits behind
 * and its turn share one start budget, as setup and boot did when the brief was pasted. The floor
 * keeps the turn the window a pasted brief always had.
 */
export function remainingLaunchObservationMs(timeoutMs: number, launchStartedAt: number): number {
  return Math.max(launchStartedAt + timeoutMs - Date.now(), AGENT_PROMPT_EFFECT_TIMEOUT_MS)
}
