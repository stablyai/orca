import { reconcileMaestroWorkerLeaseTransfer } from '../../orchestration/maestro-terminal-lease-reconciliation'
import { failWorkerStartWithReceipt } from './orchestration/worker/worker-start-receipt'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'

type LeaseTransferReceipt = { requestId: string }

type RecoverWorkerStartFailureArgs = {
  db: {
    getMaestroTerminalLease: (id: string) => { id: string; lifecycleState: string } | undefined
    retainMaestroTerminalLease: (id: string) => unknown
  }
  runId: string
  taskId: string
  dispatchId: string
  failedStage: string
  error: unknown
  setup: Parameters<typeof failWorkerStartWithReceipt>[0]['setup']
  launch: Parameters<typeof failWorkerStartWithReceipt>[0]['launch']
  attemptId: string
  terminalHandle?: string
  workerLease: MaestroTerminalLease | undefined
  leaseTransferReceipt: LeaseTransferReceipt | undefined
  recordMutationReceipt?: (receipt: unknown) => void
  residualAgentTerminal?: Parameters<typeof failWorkerStartWithReceipt>[0]['residualAgentTerminal']
}

const SETTLED_LEASE_STATES = ['released', 'archived', 'retained']

/**
 * A transferred lease outlives the failure, so its own reconciliation is the truthful
 * verdict; without one the start failed outright and any live lease is retained instead.
 */
export function recoverWorkerStartFailure(args: RecoverWorkerStartFailureArgs) {
  const { db, runId, taskId, dispatchId, failedStage } = args
  if (args.leaseTransferReceipt) {
    const leaseTransfer = reconcileMaestroWorkerLeaseTransfer({
      db: db as never,
      requestId: args.leaseTransferReceipt.requestId
    })
    const recovered = {
      runId,
      taskId,
      attemptId: args.attemptId,
      dispatchId,
      ...(args.workerLease ? { leaseId: args.workerLease.id } : {}),
      ...(args.terminalHandle ? { terminalHandle: args.terminalHandle } : {}),
      state: 'outcome_unknown',
      readiness: 'unverifiable',
      failedStage,
      leaseTransfer
    }
    args.recordMutationReceipt?.(recovered)
    return recovered
  }
  const lease = args.workerLease && db.getMaestroTerminalLease(args.workerLease.id)
  if (lease && !SETTLED_LEASE_STATES.includes(lease.lifecycleState)) {
    db.retainMaestroTerminalLease(lease.id)
  }
  return failWorkerStartWithReceipt({
    db: db as never,
    runId,
    taskId,
    dispatchId,
    failedStage,
    error: args.error,
    setup: args.setup,
    launch: args.launch,
    residualAgentTerminal: args.residualAgentTerminal,
    attemptId: args.attemptId,
    terminalHandle: args.terminalHandle,
    leaseId: args.workerLease?.id
  })
}
