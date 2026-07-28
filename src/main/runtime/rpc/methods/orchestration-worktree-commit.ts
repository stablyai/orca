import { createOrchestrationOperationCommitTracker } from '../../../../shared/orchestration-agent-prompt-outcome'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  isFederationResidualEffect,
  type FederationEffect
} from './orchestration-federation-effects'
import type { WorkerEffect } from './orchestration-worker-topology'

type CommittedWorktree = { id: string }

export function createWorkerWorktreeCommitRecorder(args: {
  db: OrchestrationDb
  dispatchId: string
  action: 'created_child' | 'created_top_level'
  effects: WorkerEffect[]
}): {
  onCommitted: (worktree: CommittedWorktree) => void
  rethrowIfCommitted: (error: unknown) => void
} {
  const effect: WorkerEffect = { kind: 'worktree', action: args.action }
  let worktreeId: string | undefined
  let persistedWorktreeId: string | undefined
  let observed = false
  const persist = (): void => {
    if (!worktreeId) {
      return
    }
    if (!args.effects.includes(effect)) {
      args.effects.push(effect)
    }
    args.db.recordWorkerStage({
      dispatchId: args.dispatchId,
      stage: 'worktree_creation_committed',
      worktreeId,
      effects: args.effects,
      residualResources: args.effects.filter((entry) => entry.action?.startsWith('created'))
    })
    persistedWorktreeId = worktreeId
  }
  const tracker = createOrchestrationOperationCommitTracker('Worktree creation', persist)
  return {
    onCommitted: (worktree) => {
      const repeated = observed
      observed = true
      worktreeId = worktree.id
      effect.id = worktree.id
      tracker.onCommitted()
      if (repeated && persistedWorktreeId !== worktree.id) {
        try {
          persist()
        } catch (error) {
          tracker.rethrowIfCommitted(error)
        }
      }
    },
    rethrowIfCommitted: tracker.rethrowIfCommitted
  }
}

export function createFederatedWorktreeCommitRecorder(args: {
  db: OrchestrationDb
  dispatchId: string
  effects: FederationEffect[]
}): {
  onCommitted: (worktree: CommittedWorktree) => void
  rethrowIfCommitted: (error: unknown) => void
} {
  const effect: FederationEffect = { kind: 'worktree', action: 'created_top_level' }
  let worktreeId: string | undefined
  let persistedWorktreeId: string | undefined
  let observed = false
  const persist = (): void => {
    if (!worktreeId) {
      return
    }
    if (!args.effects.includes(effect)) {
      args.effects.push(effect)
    }
    args.db.recordRemoteAttachmentStage({
      dispatchId: args.dispatchId,
      stage: 'worktree_creation_committed',
      worktreeId,
      effects: args.effects,
      residualResources: args.effects.filter(isFederationResidualEffect)
    })
    persistedWorktreeId = worktreeId
  }
  const tracker = createOrchestrationOperationCommitTracker('Worktree creation', persist)
  return {
    onCommitted: (worktree) => {
      const repeated = observed
      observed = true
      worktreeId = worktree.id
      effect.id = worktree.id
      tracker.onCommitted()
      if (repeated && persistedWorktreeId !== worktree.id) {
        try {
          persist()
        } catch (error) {
          tracker.rethrowIfCommitted(error)
        }
      }
    },
    rethrowIfCommitted: tracker.rethrowIfCommitted
  }
}
