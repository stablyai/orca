import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/orca-session-address'
import { canonicalOrcaSessionId } from '../../../../orchestration/canonical-orca-session-id'
import { orcaSessionIdOrHandle } from '../../../../orchestration/orchestration-party'
import {
  buildDispatchPreamble,
  dispatchPreambleSendOptions
} from '../../../../orchestration/preamble'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import type { WorkerTurnStartObservation } from './worker-start-turn-observation'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/**
 * Hands a started worker the dispatch preamble, over whichever transport it has.
 *
 * The preamble is identical for both but for how it names the worker: a worker is taught the same
 * verbs whichever mode it runs in, and only the delivery differs — a PTY write returns a
 * queued/accepted receipt, while a structured turn is acknowledged, still held for an agent that has
 * not started, or throws. Held is a turn start nobody observed yet: the start is left unknown, not
 * torn down.
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
  devMode: boolean | undefined
  requestId: string
}): Promise<{
  prompt?: RuntimeTerminalSend['prompt']
  structuredTurnStart?: WorkerTurnStartObservation
}> {
  const { runtime, structuredSession, terminalHandle } = args
  const preamble = buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: orcaSessionIdOrHandle(args.coordinatorHandle, args.db),
    // Its mailbox stays keyed by the handle; its commands name its Orca session ID, which binds to it.
    workerHandle:
      structuredSession && isOrcaSessionId(structuredSession.identity.sessionId)
        ? formatOrcaSessionAddress(canonicalOrcaSessionId(structuredSession.identity.sessionId))
        : terminalHandle,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })
  if (structuredSession) {
    const delivery = await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble
    })
    return {
      structuredTurnStart:
        delivery === 'accepted'
          ? { verdict: 'observed' }
          : {
              verdict: 'unobserved',
              reason:
                'The dispatch preamble was accepted, but the agent had not started to take it. It ' +
                'is delivered when the agent starts; if the worker then reports, this Dispatch ' +
                'settles normally.'
            }
    }
  }
  return {
    prompt: (
      await runtime.sendTerminalAgentPrompt(
        terminalHandle,
        preamble,
        dispatchPreambleSendOptions(args.requestId)
      )
    ).prompt
  }
}
