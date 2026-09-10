import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type WorkerAgentDiscoveryReceipt = {
  requestedId: TuiAgent
  resolvedId: TuiAgent
  executable: string
}

export type WorkerStartIdentityReceipt = {
  runId: string
  taskId: string
  attemptId: string
  dispatchId: string
  leaseId: string
  terminalHandle: string
  readiness: 'pending' | 'ready' | 'unverifiable'
  agentDiscovery?: WorkerAgentDiscoveryReceipt
}

export function createWorkerAgentDiscoveryReceipt(agent: TuiAgent): WorkerAgentDiscoveryReceipt {
  return {
    requestedId: agent,
    resolvedId: agent,
    executable: TUI_AGENT_CONFIG[agent].detectCmd
  }
}

export function createPendingWorkerStartReceipt(
  identity: Omit<WorkerStartIdentityReceipt, 'readiness'>
): WorkerStartIdentityReceipt {
  return { ...identity, readiness: 'pending' }
}

export function createWorkerStartRecoveryCommand(args: {
  executable: string
  taskId: string
  dispatchId: string
  attemptId?: string
  terminalHandle?: string
  exactRetryAvailable: boolean
}): string {
  if (args.exactRetryAvailable && args.attemptId && args.terminalHandle) {
    return `${args.executable} orchestration worker-start --task ${args.taskId} --terminal ${args.terminalHandle} --attempt-id ${args.attemptId} --retry-of ${args.dispatchId} --json`
  }
  return `${args.executable} orchestration replace-worker --task ${args.taskId} --predecessor ${args.dispatchId} --json`
}

export function isReadinessUnverifiable(error: unknown, failedStage: string): boolean {
  if (failedStage !== 'agent_readiness') {
    return false
  }
  if (!(error instanceof Error)) {
    return false
  }
  return error.message === 'worker_readiness_unverifiable' || error.message === 'timeout'
}
