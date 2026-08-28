import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildDispatchPreamble, buildRetainedDispatchDelta } from '../../orchestration/preamble'
import type { TaskRow } from '../../orchestration/types'
import {
  resolveBoundOutcomeId,
  resolveRetainedReengagement
} from './orchestration-worker-route-admission'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

/** B5 (correction 3) — what actually reaches the worker pane.
 *
 *  A fresh session gets the concise bootstrap. A session Orca already owns in
 *  this Run — the FIX_FIRST shape, where `--terminal` names the retained
 *  builder — gets only the dispatch delta plus the new task, because resending
 *  the lifecycle manual is what buries the correction.
 */
export async function deliverWorkerDispatchPrompt(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: TaskRow
  params: WorkerStartInput
  dispatchId: string
  depth: number
  terminalHandle: string
  capability: string | undefined
}): Promise<{ retained: boolean }> {
  const { runtime, db, params, task } = args
  const retained = resolveRetainedReengagement(db, {
    terminal: params.terminal,
    runId: args.runId,
    dispatchId: args.dispatchId
  })
  const preambleParams = {
    canDispatchSubWorkers: args.depth < runtime.getNestedWorkerMaxDepth(),
    taskId: task.id,
    dispatchId: args.dispatchId,
    runId: args.runId,
    // Why bound here: the worker's completion receipt must claim the same
    // outcome the Run was admitted under, and it cannot infer it.
    outcomeId: resolveBoundOutcomeId(db, args.runId),
    taskSpec: task.spec,
    coordinatorHandle: params.from,
    workerHandle: args.terminalHandle,
    dispatchCapability: args.capability,
    devMode: params.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(args.terminalHandle)
  }
  await runtime.sendTerminalAgentPrompt(
    args.terminalHandle,
    retained
      ? buildRetainedDispatchDelta({
          ...preambleParams,
          previousTaskId: retained.previousTaskId,
          previousDispatchId: retained.previousDispatchId
        })
      : buildDispatchPreamble(preambleParams)
  )
  return { retained: retained !== null }
}
