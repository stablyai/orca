import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { buildCollaborationWorkerProtocol } from '../../../../collaboration/collaboration-worker-protocol'
import { getCollaborationRuntimeTopology } from '../../../../collaboration/collaboration-runtime-registry'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/**
 * Hands a started worker the dispatch preamble, over whichever transport it has.
 *
 * The preamble itself is identical for both: a worker is taught the same verbs whichever mode it
 * runs in, and only the delivery differs — a PTY write returns a queued/accepted receipt, while a
 * structured turn either is acknowledged or throws.
 */
export async function deliverWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  runId: string
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  dispatchCapability: string
  devMode: boolean | undefined
  requestId: string
}): Promise<RuntimeTerminalSend['prompt']> {
  const { runtime, structuredSession, terminalHandle } = args
  const cliCommand = runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  const collaborationStep = getCollaborationRuntimeTopology(runtime, args.runId)?.steps.find(
    (step) => step.taskId === args.taskId
  )
  const preCompletionProtocol = collaborationStep
    ? buildCollaborationWorkerProtocol({
        cli: args.devMode ? 'orca-dev' : (cliCommand ?? 'orca'),
        workerHandle: terminalHandle,
        dispatchCapability: args.dispatchCapability,
        publishesTo: collaborationStep.publishesTo ?? [],
        requiredPublishesTo: collaborationStep.requiredPublishesTo ?? [],
        subscribesTo: collaborationStep.subscribesTo ?? []
      })
    : undefined
  const preamble = buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: terminalHandle,
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    cliCommand,
    preCompletionProtocol
  })
  if (structuredSession) {
    await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble
    })
    return undefined
  }
  return (
    await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: args.requestId
    })
  ).prompt
}
