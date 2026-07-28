import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildDispatchPreamble } from '../../orchestration/preamble'

type DispatchInputEffect = {
  kind: 'dispatch_input'
  role: 'agent'
  id: string
  state: 'accepted'
}

export async function deliverOrchestrationWorkerPrompt(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  taskId: string
  dispatchId: string
  taskSpec: string
  coordinatorHandle: string
  dispatchCapability: string
  devMode?: boolean
  beforeWrite: () => Promise<void>
  effects: { push(effect: DispatchInputEffect): unknown }
}): Promise<void> {
  const { runtime, terminalHandle } = args
  const preamble = buildDispatchPreamble({
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: terminalHandle,
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })
  await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
    beforeWrite: args.beforeWrite
  })
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: terminalHandle,
    state: 'accepted'
  })
}
