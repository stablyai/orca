import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'
import { createExistingWorktreeWorkerTerminal } from './worker-topology'
import { createWorkerWorktree } from './worker-worktree-creation'
import { recordCreatedWorkerTerminalCustody } from './created-worker-terminal-custody'

export async function prepareLocalWorkerTerminalSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  requestedWorktree: string
  creationWorktree?: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  resolvedWorktree?: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle?: string
  setupReceipt: WorkerSetupReceipt
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  taskId: string
  params: Parameters<typeof createWorkerWorktree>[0]['params'] & { terminal?: string }
  effects: WorkerEffect[]
}): Promise<{
  resolvedWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
  setupReceipt: WorkerSetupReceipt
  terminalRevealWarning?: string
  setupStage: {
    db: OrchestrationDb
    dispatchId: string
    worktreeId: string
    terminalHandle: string
    setup: WorkerSetupReceipt
    effects: WorkerEffect[]
  }
}> {
  let resolvedWorktree = args.resolvedWorktree
  let terminalHandle = args.terminalHandle
  let setupReceipt = args.setupReceipt
  let terminalRevealWarning: string | undefined
  if (args.creationWorktree) {
    const created = await createWorkerWorktree({
      runtime: args.runtime,
      db: args.db,
      dispatchId: args.dispatchId,
      requestedWorktree: args.requestedWorktree,
      coordinatorWorktree: args.creationWorktree,
      params: args.params,
      agent: args.agent,
      withAgentTerminal: true,
      launchPreferences: args.launchPreferences,
      effects: args.effects
    })
    resolvedWorktree = created.worktree
    terminalHandle = created.terminalHandle
    setupReceipt = created.setupReceipt
  } else if (!terminalHandle) {
    if (!resolvedWorktree) {
      throw new Error('Worker topology did not resolve a worktree before terminal creation.')
    }
    args.db.recordWorkerStage({
      dispatchId: args.dispatchId,
      stage: 'terminal_creating',
      worktreeId: resolvedWorktree.id,
      effects: args.effects
    })
    const terminal = await createExistingWorktreeWorkerTerminal({
      runtime: args.runtime,
      worktreeId: resolvedWorktree.id,
      agent: args.agent,
      launchPreferences: args.launchPreferences,
      taskId: args.taskId,
      effects: args.effects
    })
    terminalHandle = terminal.handle
    terminalRevealWarning = terminal.warning
  } else {
    args.effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'reused',
      id: terminalHandle
    })
  }
  if (!resolvedWorktree || !terminalHandle) {
    throw new Error('Worker topology did not resolve an agent terminal and worktree.')
  }
  const setupStage = {
    db: args.db,
    dispatchId: args.dispatchId,
    worktreeId: resolvedWorktree.id,
    terminalHandle,
    setup: setupReceipt,
    effects: args.effects
  }
  recordCreatedWorkerTerminalCustody(args.runtime, setupStage, !args.params.terminal)
  return {
    resolvedWorktree,
    terminalHandle,
    setupReceipt,
    terminalRevealWarning,
    setupStage
  }
}
