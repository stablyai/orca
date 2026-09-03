import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { isAgentPromptStalledError } from '../../agent-prompt-submission-verification'
import {
  monitorWorkerSetup,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

/** Reconcile a timed-out prompt only from evidence correlated to this exact worker attempt. */
export function recoverStalledWorkerPrompt(args: {
  error: unknown
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  terminalHandle?: string
  taskId: string
  dispatchId: string
  processIncarnation?: string
  submittedAt?: number
  effects: WorkerEffect[]
}) {
  if (
    !isAgentPromptStalledError(args.error) ||
    !args.terminalHandle ||
    !args.processIncarnation ||
    !args.submittedAt
  ) {
    return null
  }
  const evidence = args.runtime.getOrchestrationPromptDeliveryEvidence({
    terminalHandle: args.terminalHandle,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    processIncarnation: args.processIncarnation,
    submittedAt: args.submittedAt
  })
  if (!evidence) {
    return null
  }
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: evidence
  })
  return args.db.markWorkerDispatchReady(args.dispatchId, args.effects, evidence)
}

/** Apply the common post-ready setup observer and build the successful worker-start receipt. */
export function finishReadyWorkerStart(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  worker: { state: string; stage: string }
  setup: WorkerSetupReceipt
  launch: unknown
  timeoutMs: number
  effects: WorkerEffect[]
  warning?: string
}) {
  monitorWorkerSetup({
    runtime: args.runtime,
    db: args.db,
    runId: args.runId,
    dispatchId: args.dispatchId,
    setupReceipt: args.setup,
    effects: args.effects
  })
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: args.worker.state,
    stage: args.worker.stage,
    setup: args.setup,
    launch: args.launch,
    timeoutMs: args.timeoutMs,
    effects: args.effects,
    residualResources: [],
    ...(args.warning ? { warning: args.warning } : {})
  }
}
