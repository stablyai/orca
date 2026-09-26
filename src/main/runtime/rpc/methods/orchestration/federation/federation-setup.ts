import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { applyWaitForSetupOutcome, type WorkerSetupReceipt } from '../worker/worker-topology'
import { isFederationResidualEffect, type FederationEffect } from './federation-effects'

type FederationSetupStageArgs = {
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  terminalHandle: string
  setup: WorkerSetupReceipt
  effects: FederationEffect[]
}

/** One writer derives what a stage leaves behind, so no caller can persist a narrower residual
 *  set than the effects it just recorded. */
function writeStage(args: {
  db: OrchestrationDb
  dispatchId: string
  stage: string
  worktreeId: string
  terminalHandle?: string
  setupState?: string
  effects: FederationEffect[]
}): void {
  args.db.recordRemoteAttachmentStage({
    dispatchId: args.dispatchId,
    stage: args.stage,
    worktreeId: args.worktreeId,
    ...(args.terminalHandle ? { terminalHandle: args.terminalHandle } : {}),
    ...(args.setupState ? { setupState: args.setupState } : {}),
    effects: args.effects,
    residualResources: args.effects.filter(isFederationResidualEffect)
  })
}

function recordStage(args: FederationSetupStageArgs, stage: string): void {
  writeStage({
    db: args.db,
    dispatchId: args.dispatchId,
    stage,
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects
  })
}

/**
 * The remote worktree exists from `createManagedWorktree` onward, but nothing owned it until the
 * terminal was ready. Recording it here, before any later step can throw, is what lets a failed
 * attach name something to reclaim: the attachment row is the only record the home peer reads back.
 */
export function persistFederatedWorktreeCreation(args: {
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  effects: FederationEffect[]
}): void {
  writeStage({ ...args, stage: 'worktree_created' })
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

export function monitorFederatedSetup(
  args: FederationSetupStageArgs & { runtime: OrcaRuntimeService }
): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setup.startupPolicy !== 'start-immediately' ||
    args.setup.state !== 'running'
  ) {
    return
  }
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const effects = args.effects.map((effect) =>
        effect.kind === 'setup' ? { ...effect, state: setupState } : effect
      )
      const evidence = args.db.updateRemoteAttachmentSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects
      })
      if (!evidence.changed) {
        return
      }
      args.db.enqueueFederationRelay({
        dispatchId: args.dispatchId,
        direction: 'to_home',
        kind: 'status',
        payload: JSON.stringify({
          from: `dispatch:${args.dispatchId}`,
          subject: `Setup ${setupState} for worker ${args.dispatchId}`,
          body: '',
          type: 'status',
          priority: setupState === 'failed' ? 'high' : 'normal',
          threadId: null,
          payload: JSON.stringify({
            dispatchId: args.dispatchId,
            setupState,
            terminalHandle: setupTerminal.id
          })
        })
      })
    })
    .catch(() => undefined)
}
