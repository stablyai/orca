import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import { recordZcodeReadinessFailure } from './orchestration-worker-zcode'

export function monitorWorkerSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setupReceipt.startupPolicy !== 'start-immediately' ||
    args.setupReceipt.state !== 'running'
  ) {
    return
  }
  // Why: setup is intentionally non-gating, but command completion remains durable evidence.
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const evidence = args.db.updateWorkerSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects: args.effects.map((effect) =>
          effect.kind === 'setup' ? { ...effect, state: setupState } : effect
        )
      })
      if (!evidence.changed) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Setup ${setupState} for worker ${args.dispatchId}`,
        type: 'status',
        priority: setupState === 'failed' ? 'high' : 'normal',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          setupState,
          terminalHandle: setupTerminal.id
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
}

export function finalizeWorkerStart(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  timeoutMs: number
  setupReceipt: WorkerSetupReceipt
  launchReceipt: OrchestrationWorkerLaunchReceipt
  effects: WorkerEffect[]
  warning?: string
}) {
  const worker = args.db.markWorkerDispatchReady(args.dispatchId, args.effects)
  monitorWorkerSetup({
    runtime: args.runtime,
    db: args.db,
    runId: args.runId,
    dispatchId: args.dispatchId,
    setupReceipt: args.setupReceipt,
    effects: args.effects
  })
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: worker.state,
    stage: worker.stage,
    setup: args.setupReceipt,
    launch: args.launchReceipt,
    timeoutMs: args.timeoutMs,
    effects: args.effects,
    residualResources: [],
    ...(args.warning ? { warning: args.warning } : {})
  }
}

export async function deliverWorkerDispatchInput(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  agent: TuiAgent
  promptDelivery: 'agent-input' | 'startup-command'
  preamble: string
  launchPreferences?: AgentLaunchPreferences
  effects: WorkerEffect[]
}): Promise<void> {
  await (args.promptDelivery === 'startup-command'
    ? args.runtime.sendTerminalAgentStartupPrompt(
        args.terminalHandle,
        args.agent,
        args.preamble,
        args.launchPreferences
      )
    : args.runtime.sendTerminalAgentPrompt(args.terminalHandle, args.preamble))
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: 'accepted'
  })
}

export function prepareWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  taskId: string
  taskSpec: string
  dispatchId: string
  coordinatorHandle: string
  terminalHandle: string
  worktreeId: string
  effects: WorkerEffect[]
  setupState: WorkerSetupReceipt['state']
  terminalOwnership: 'external' | 'created'
  devMode?: boolean
  promptDelivery: 'agent-input' | 'startup-command'
}): string {
  const capability = args.db.prepareStartingWorkerAuthority({
    dispatchId: args.dispatchId,
    handle: args.terminalHandle,
    ...requireWorkerAuthority(args.runtime, args.terminalHandle),
    worktreeId: args.worktreeId,
    effects: args.effects,
    setupState: args.setupState,
    terminalOwnership: args.terminalOwnership
  })
  return buildDispatchPreamble({
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: args.terminalHandle,
    dispatchCapability: capability,
    devMode: args.devMode,
    cliCommand: args.runtime.getTerminalOrchestrationCliCommand(args.terminalHandle),
    ...(args.promptDelivery === 'startup-command' ? { workerKind: 'one-shot-agent' } : {})
  })
}

export function failLocalWorkerStart(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  agent: TuiAgent | null | undefined
  promptDelivery: 'agent-input' | 'startup-command'
}) {
  recordZcodeReadinessFailure(args)
  return failWorkerStartWithReceipt(args)
}
