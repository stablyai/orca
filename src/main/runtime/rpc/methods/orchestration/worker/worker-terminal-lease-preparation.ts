import type { MaestroTerminalLaunchProfile } from '../../../../../../shared/maestro-terminal-lease'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerEffect } from './worker-topology'
import type {
  PreparedWorkerTerminalLease,
  WorkerTerminalLeaseArgs
} from './worker-terminal-lease-activation'
import type { DurableWorkerMutationIdentity } from '../../orchestration-worker-terminal-lease-types'
import { prepareWorkerTerminalTransferAuthority } from '../../../../orchestration/db/worker-terminal/worker-terminal-start-authority'
import { createPendingWorkerStartReceipt } from '../../orchestration-worker-start'
import { prepareWorkerTerminalLease } from './worker-terminal-lease-activation'

export function prepareLocalWorkerTerminalLease(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  attemptId: string
  terminalHandle: string
  terminal: { tabId?: string; ptyId?: string | null }
  terminalAuthority: WorkerTerminalLeaseArgs['terminalAuthority']
  leaseTitle: string
  effects: WorkerEffect[]
  runId: string
  taskId: string
  taskSpec: string
  canDispatchSubWorkers: boolean
  coordinatorGeneration: number
  dispatchId: string
  retryOf?: string
  mutation?: DurableWorkerMutationIdentity
  retryPreflight?: Parameters<typeof prepareWorkerTerminalTransferAuthority>[0]['retryPreflight']
  preflightExecutable: string
  retryResourceId?: string
  retryPredecessorLeaseId?: string
  launchProfile: MaestroTerminalLaunchProfile
  coordinatorHandle: string
  devMode?: boolean
  externalTerminal: boolean
  worktreeId: string
  setupState: Parameters<typeof prepareWorkerTerminalTransferAuthority>[0]['setupState']
  agentDiscovery?: Parameters<typeof createPendingWorkerStartReceipt>[0]['agentDiscovery']
  onLeaseTransfer?: WorkerTerminalLeaseArgs['onLeaseTransfer']
  recordMutationReceipt?: (receipt: unknown) => void
}): {
  leaseArgs: WorkerTerminalLeaseArgs
  preparedLease: PreparedWorkerTerminalLease
} {
  const authority = prepareWorkerTerminalTransferAuthority({
    db: args.db,
    terminalHandle: args.terminalHandle,
    terminalAuthority: args.terminalAuthority,
    retryPreflight: args.retryPreflight,
    effects: args.effects,
    retryOf: args.retryOf,
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    setupState: args.setupState,
    externalTerminal: args.externalTerminal
  })
  const leaseArgs: WorkerTerminalLeaseArgs = {
    db: args.db,
    runtime: args.runtime,
    attemptId: args.attemptId,
    terminalHandle: args.terminalHandle,
    terminal: args.terminal,
    terminalAuthority: args.terminalAuthority,
    leaseTitle: args.leaseTitle,
    effects: args.effects,
    runId: args.runId,
    taskId: args.taskId,
    taskSpec: args.taskSpec,
    canDispatchSubWorkers: args.canDispatchSubWorkers,
    coordinatorGeneration: args.coordinatorGeneration,
    dispatchId: args.dispatchId,
    retryOf: args.retryOf,
    mutation: args.mutation,
    preflightExecutable: args.preflightExecutable,
    retryResourceId: args.retryResourceId,
    retryPredecessorLeaseId: args.retryPredecessorLeaseId,
    reusableResourceId: authority.reusableResourceId,
    launchProfile: args.launchProfile,
    capability: authority.capability,
    coordinatorHandle: args.coordinatorHandle,
    devMode: args.devMode,
    onLeaseTransfer: (receipt) => args.onLeaseTransfer?.(receipt)
  }
  const preparedLease = prepareWorkerTerminalLease(leaseArgs)
  args.recordMutationReceipt?.(
    createPendingWorkerStartReceipt({
      runId: args.runId,
      taskId: args.taskId,
      attemptId: args.attemptId,
      terminalHandle: args.terminalHandle,
      dispatchId: args.dispatchId,
      leaseId: preparedLease.workerLease.id,
      ...(args.agentDiscovery ? { agentDiscovery: args.agentDiscovery } : {})
    })
  )
  return { leaseArgs, preparedLease }
}
