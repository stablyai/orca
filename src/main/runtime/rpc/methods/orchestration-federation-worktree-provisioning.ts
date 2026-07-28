import type { TuiAgent } from '../../../../shared/types'
import {
  createOrchestrationOperationCommitTracker,
  isAgentSessionOperationOutcomeUnknown
} from '../../../../shared/orchestration-agent-prompt-outcome'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  isFederationResidualEffect,
  type FederationEffect
} from './orchestration-federation-effects'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'
import { createFederatedWorktreeCommitRecorder } from './orchestration-worktree-commit'

type TerminalIdentity = {
  agentSessionCreateOperationId: string
  tabId: string
  leafId: string
  preAllocatedHandle: string
}

export async function createFederatedWorkerWorktree(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  repo: string
  name: string
  baseBranch?: string
  displayName?: string
  comment?: string
  setupDecision: 'run' | 'skip' | 'inherit'
  setupSource: string
  agent: TuiAgent
  signal: AbortSignal
  terminalIdentity: TerminalIdentity
  effects: FederationEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>['worktree']
  terminalHandle: string
  setup: WorkerSetupReceipt
}> {
  args.db.recordRemoteAttachmentStage({
    dispatchId: args.dispatchId,
    stage: 'worktree_creating'
  })
  const committedTerminalEffect: FederationEffect = {
    kind: 'terminal',
    role: 'agent',
    action: 'created_pending_receipt',
    id: args.terminalIdentity.preAllocatedHandle
  }
  const worktreeCommit = createFederatedWorktreeCommitRecorder(args)
  const startupCommit = createOrchestrationOperationCommitTracker(
    'Startup terminal creation',
    () => {
      args.effects.push(committedTerminalEffect)
      args.db.recordRemoteAttachmentStage({
        dispatchId: args.dispatchId,
        stage: 'terminal_creation_committed',
        terminalHandle: args.terminalIdentity.preAllocatedHandle,
        effects: args.effects,
        residualResources: args.effects.filter(isFederationResidualEffect)
      })
    }
  )
  let created
  try {
    created = await args.runtime.createManagedWorktree({
      repoSelector: args.repo,
      name: args.name,
      baseBranch: args.baseBranch,
      displayName: args.displayName,
      comment: args.comment,
      runHooks: args.setupDecision === 'run',
      setupDecision: args.setupDecision,
      awaitTerminalProvisioning: true,
      observeSetupCompletion: true,
      createdWithAgent: args.agent,
      startupAgent: args.agent,
      activate: false,
      lineage: { noParent: true },
      signal: args.signal,
      onWorktreeCreateCommitted: worktreeCommit.onCommitted,
      startupTerminalIdentity: {
        ...args.terminalIdentity,
        onPtySpawnCommitted: startupCommit.onCommitted
      }
    })
    const terminalHandle = created.startupTerminal?.handle
    worktreeCommit.onCommitted(created.worktree)
    const setup: WorkerSetupReceipt = {
      requested: args.setupDecision,
      effective: args.setupDecision,
      source: args.setupSource,
      hookFound: created.setupReceipt?.hookFound ?? false,
      startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
      state: created.setupReceipt?.state ?? 'not_configured'
    }
    args.db.recordRemoteAttachmentStage({
      dispatchId: args.dispatchId,
      stage: 'worktree_created',
      worktreeId: created.worktree.id,
      effects: args.effects,
      residualResources: args.effects.filter(isFederationResidualEffect)
    })
    if (!terminalHandle) {
      throw new Error(created.warning ?? 'Agent-first worktree creation returned no terminal.')
    }
    const committedEffectIndex = args.effects.indexOf(committedTerminalEffect)
    if (committedEffectIndex >= 0) {
      args.effects.splice(committedEffectIndex, 1)
    }
    const listed = await args.runtime.listTerminals(`id:${created.worktree.id}`)
    appendFederationTerminalEffects(
      args.effects,
      listed.terminals,
      terminalHandle,
      created.setupReceipt?.terminalHandle
    )
    appendFederationSetupEffect(args.effects, setup)
    args.db.recordRemoteAttachmentStage({
      dispatchId: args.dispatchId,
      stage: 'worktree_created',
      worktreeId: created.worktree.id,
      terminalHandle,
      setupState: setup.state,
      effects: args.effects,
      residualResources: args.effects.filter(isFederationResidualEffect)
    })
    return { worktree: created.worktree, terminalHandle, setup }
  } catch (error) {
    if (isAgentSessionOperationOutcomeUnknown(error)) {
      startupCommit.onCommitted()
    }
    startupCommit.rethrowIfCommitted(error)
    worktreeCommit.rethrowIfCommitted(error)
    throw error
  }
}
