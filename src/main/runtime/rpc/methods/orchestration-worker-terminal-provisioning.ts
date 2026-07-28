import {
  createOrchestrationOperationCommitTracker,
  isOrchestrationOperationOutcomeUnknown
} from '../../../../shared/orchestration-agent-prompt-outcome'
import type { TuiAgent } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { waitForOrchestrationProvisioning } from './orchestration-agent-prompt-readiness'
import {
  isFederationResidualEffect,
  type FederationEffect
} from './orchestration-federation-effects'
import type { WorkerEffect } from './orchestration-worker-topology'

type TerminalIdentity = {
  agentSessionCreateOperationId: string
  tabId: string
  leafId: string
  preAllocatedHandle: string
}

type ProvisionedTerminal = Awaited<ReturnType<OrcaRuntimeService['createTerminal']>>

function upsertTerminalEffect(
  effects: WorkerEffect[] | FederationEffect[],
  handle: string,
  action: 'created_pending_receipt' | 'created'
): void {
  const existing = effects.find((effect) => effect.kind === 'terminal' && effect.role === 'agent')
  if (existing) {
    existing.action = action
    existing.id = handle
    return
  }
  effects.push({ kind: 'terminal', role: 'agent', action, id: handle })
}

function workerResidualEffects(effects: WorkerEffect[]): WorkerEffect[] {
  return effects.filter(
    (effect) => effect.action?.startsWith('created') || effect.action === 'reused_agent_terminal'
  )
}

export async function provisionWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  taskId: string
  worktreeId: string
  agent: TuiAgent
  signal: AbortSignal
  terminalIdentity: TerminalIdentity
  effects: WorkerEffect[]
}): Promise<ProvisionedTerminal> {
  const record = (handle: string, action: 'created_pending_receipt' | 'created'): void => {
    upsertTerminalEffect(args.effects, handle, action)
    args.db.recordWorkerStage({
      dispatchId: args.dispatchId,
      stage: action === 'created' ? 'terminal_created' : 'terminal_creation_committed',
      worktreeId: args.worktreeId,
      terminalHandle: handle,
      effects: args.effects,
      residualResources: workerResidualEffects(args.effects)
    })
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_creating',
    worktreeId: args.worktreeId,
    effects: args.effects
  })
  const commit = createOrchestrationOperationCommitTracker('Worker terminal creation', () => {
    record(args.terminalIdentity.preAllocatedHandle, 'created_pending_receipt')
  })
  const provisioning = args.runtime
    .createTerminal(`id:${args.worktreeId}`, {
      command: args.agent,
      title: `worker-${args.taskId}`,
      presentation: 'background',
      signal: args.signal,
      ...args.terminalIdentity,
      onPtySpawnCommitted: commit.onCommitted
    })
    .then((terminal) => {
      record(terminal.handle, 'created')
      return terminal
    })
    .catch((error) => {
      if (isOrchestrationOperationOutcomeUnknown(error)) {
        commit.onCommitted()
      }
      commit.rethrowIfCommitted(error)
      throw error
    })
  return await waitForOrchestrationProvisioning(provisioning, args.signal)
}

export async function provisionFederatedWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  taskId: string
  worktreeId: string
  agent: TuiAgent
  signal: AbortSignal
  terminalIdentity: TerminalIdentity
  effects: FederationEffect[]
}): Promise<ProvisionedTerminal> {
  const record = (handle: string, action: 'created_pending_receipt' | 'created'): void => {
    upsertTerminalEffect(args.effects, handle, action)
    args.db.recordRemoteAttachmentStage({
      dispatchId: args.dispatchId,
      stage: action === 'created' ? 'terminal_created' : 'terminal_creation_committed',
      worktreeId: args.worktreeId,
      terminalHandle: handle,
      effects: args.effects,
      residualResources: args.effects.filter(isFederationResidualEffect)
    })
  }
  args.db.recordRemoteAttachmentStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_creating',
    worktreeId: args.worktreeId,
    effects: args.effects
  })
  const commit = createOrchestrationOperationCommitTracker(
    'Federated worker terminal creation',
    () => {
      record(args.terminalIdentity.preAllocatedHandle, 'created_pending_receipt')
    }
  )
  const provisioning = args.runtime
    .createTerminal(`id:${args.worktreeId}`, {
      command: args.agent,
      title: `worker-${args.taskId}`,
      presentation: 'background',
      signal: args.signal,
      ...args.terminalIdentity,
      onPtySpawnCommitted: commit.onCommitted
    })
    .then((terminal) => {
      record(terminal.handle, 'created')
      return terminal
    })
    .catch((error) => {
      if (isOrchestrationOperationOutcomeUnknown(error)) {
        commit.onCommitted()
      }
      commit.rethrowIfCommitted(error)
      throw error
    })
  return await waitForOrchestrationProvisioning(provisioning, args.signal)
}
