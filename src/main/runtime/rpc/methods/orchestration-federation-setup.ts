import type { OrchestrationDb } from '../../orchestration/db'
import { applyWaitForSetupOutcome, type WorkerSetupReceipt } from './orchestration-worker-topology'
import {
  isFederationResidualEffect,
  type FederationEffect
} from './orchestration-federation-effects'

type FederationSetupStageArgs = {
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  terminalHandle: string
  setup: WorkerSetupReceipt
  effects: FederationEffect[]
}

function recordStage(args: FederationSetupStageArgs, stage: string): void {
  args.db.recordRemoteAttachmentStage({
    dispatchId: args.dispatchId,
    stage,
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: args.effects.filter(isFederationResidualEffect)
  })
}

export function persistFederatedReadinessStage(args: FederationSetupStageArgs): void {
  recordStage(args, 'terminal_readying')
}

export function persistFederatedSetupSpawnFailure(args: FederationSetupStageArgs): boolean {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'spawn_failed') {
    return false
  }
  recordStage(args, 'setup_start')
  return true
}

export function persistFederatedSetupWaitOutcome(
  args: FederationSetupStageArgs & { wait: { satisfied: boolean; status: string } }
): void {
  applyWaitForSetupOutcome(args.setup, args.effects, args.wait)
  if (args.setup.startupPolicy === 'wait-for-setup') {
    recordStage(args, args.setup.state === 'failed' ? 'setup_failed' : 'setup_settled')
  }
}
