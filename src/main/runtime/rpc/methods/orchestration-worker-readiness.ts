import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { attachWorkerAuthority, bindAndMarkArgvWorkerReady } from './orchestration-worker-authority'
import { publishWorkerStartupBlocked } from './orchestration-worker-argv-start'
import {
  monitorWorkerSetup,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'

export async function attachWorkerAndAwaitReadiness(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  terminalHandle: string
  worktreeId: string
  effects: WorkerEffect[]
  setupReceipt: WorkerSetupReceipt
  terminalOwnership: 'created' | 'external'
  task: { id: string; spec: string }
  coordinatorHandle: string
  devMode?: boolean
  argv: boolean
  timeoutMs: number
  onStage: (stage: string) => void
}): Promise<NonNullable<ReturnType<OrchestrationDb['getWorkerDispatch']>>> {
  const setupStage = {
    db: args.db,
    dispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setup: args.setupReceipt,
    effects: args.effects
  }
  if (persistGatedSetupSpawnFailure(setupStage)) {
    args.onStage('setup_start')
    throw new Error('Setup terminal failed to start before the gated agent launch.')
  }
  persistWorkerReadinessStage(setupStage)

  let worker
  if (args.argv) {
    worker = await bindAndMarkArgvWorkerReady({
      runtime: args.runtime,
      db: args.db,
      runId: args.runId,
      dispatchId: args.dispatchId,
      terminalHandle: args.terminalHandle,
      worktreeId: args.worktreeId,
      effects: args.effects,
      setupReceipt: args.setupReceipt,
      terminalOwnership: args.terminalOwnership,
      task: args.task,
      coordinatorHandle: args.coordinatorHandle,
      devMode: args.devMode
    })
  }

  args.onStage('agent_readiness')
  const wait = await args.runtime.waitForTerminal(args.terminalHandle, {
    condition: 'tui-idle',
    timeoutMs: args.timeoutMs
  })
  persistWorkerSetupWaitOutcome({ ...setupStage, wait })
  if (worker) {
    worker = args.db.getWorkerDispatch(args.dispatchId) ?? worker
  }
  if (!wait.satisfied) {
    if (args.setupReceipt.state === 'failed' && worker?.state !== 'succeeded') {
      args.onStage('setup_wait')
    }
    if (worker && ['succeeded', 'failed'].includes(worker.state)) {
      return worker
    }
    if (
      args.argv &&
      worker?.state === 'ready' &&
      args.setupReceipt.startupPolicy !== 'wait-for-setup'
    ) {
      publishWorkerStartupBlocked({
        runtime: args.runtime,
        db: args.db,
        runId: args.runId,
        dispatchId: args.dispatchId,
        terminalHandle: args.terminalHandle,
        blockedReason: wait.blockedReason ?? 'Terminal readiness wait was not satisfied.'
      })
      return worker
    }
    throw new Error(
      wait.blockedReason
        ? `Agent startup blocked: ${wait.blockedReason}`
        : `Agent did not become ready (${wait.status}).`
    )
  }
  if (!worker) {
    args.onStage('dispatch_input')
    await attachWorkerAuthority({
      runtime: args.runtime,
      db: args.db,
      dispatchId: args.dispatchId,
      terminalHandle: args.terminalHandle,
      worktreeId: args.worktreeId,
      effects: args.effects,
      setupState: args.setupReceipt.state,
      terminalOwnership: args.terminalOwnership,
      task: args.task,
      coordinatorHandle: args.coordinatorHandle,
      devMode: args.devMode,
      argv: false
    })
    args.effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: args.terminalHandle,
      state: 'accepted'
    })
    worker = args.db.markWorkerDispatchReady(args.dispatchId, args.effects)
    monitorWorkerSetup({
      runtime: args.runtime,
      db: args.db,
      runId: args.runId,
      dispatchId: args.dispatchId,
      setupReceipt: args.setupReceipt,
      effects: args.effects
    })
  }
  return worker
}
