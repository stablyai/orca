import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  buildDispatchPreamble,
  dispatchPreambleSendOptions
} from '../../../../orchestration/preamble'
import { structuredSessionCliInvocation } from '../../../../orchestration/cli-command'
import { agentVisibleOrchestrationAddress } from '../../../../orchestration/structured-session-mail-address'
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
  db: OrchestrationDb
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  dispatchCapability: string
  devMode: boolean | undefined
  requestId: string
}): Promise<RuntimeTerminalSend['prompt']> {
  const { runtime, structuredSession, terminalHandle } = args
  const preamble = buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: agentVisibleOrchestrationAddress(args.coordinatorHandle, args.db),
    workerHandle: terminalHandle,
    ...(structuredSession
      ? {
          structuredSession: {
            sessionId: structuredSession.identity.sessionId,
            cliInvocation: structuredSessionCliInvocation({
              platform: process.platform,
              // Registered with its agent at start; null only for an entry rehydrated later.
              provider: structuredSession.identity.agent ?? 'claude'
            })
          }
        }
      : {}),
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
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
    await runtime.sendTerminalAgentPrompt(
      terminalHandle,
      preamble,
      dispatchPreambleSendOptions(args.requestId)
    )
  ).prompt
}
