import type { OrchestrationDb } from './db'
import type { TaskRow } from './types'
import { buildDispatchPreamble } from './preamble'
import { sendAgentTurn } from './send-agent-turn'
import type { CoordinatorRuntime, WorktreeDrift } from './coordinator-runtime-contract'
import {
  DISPATCH_STALE_THRESHOLD,
  parseAllowStaleBaseFromSpec
} from './coordinator-stale-base-flag'
import { isAgentPromptStalledError } from '../agent-prompt-submission-verification'
import { takesNewWork } from './db/worker-terminal/worker-terminal-transfer'

/** `dispatched-unobserved`: the preamble landed but the worker's turn start was never observed. */
export type TaskDispatchResult = 'dispatched' | 'dispatched-unobserved' | 'stale-base-refused'

/** The pane, process and host a Dispatch to `handle` records; the census reads the same. */
function assigneeAuthority(runtime: CoordinatorRuntime, handle: string) {
  const dispatchAuthority = runtime.getOrchestrationDispatchAuthority?.(handle)
  return {
    assigneePaneKey:
      dispatchAuthority?.paneKey ?? runtime.getTerminalPaneKey?.(handle) ?? undefined,
    launchTokenHash: dispatchAuthority?.launchTokenHash ?? undefined,
    processIncarnation:
      dispatchAuthority?.paneKey && dispatchAuthority.processIncarnation
        ? dispatchAuthority.processIncarnation
        : undefined,
    hostScope: dispatchAuthority?.hostScope ? JSON.stringify(dispatchAuthority.hostScope) : null
  }
}

export async function listAvailableWorkerTerminals(
  db: OrchestrationDb,
  runtime: CoordinatorRuntime,
  coordinatorHandle: string,
  worktree: string | undefined
): Promise<string[] | null> {
  try {
    const result = await runtime.listTerminals(worktree, undefined, {
      includeVisualLayouts: false
    })
    // The dispatch lock enforces correctness; filtering skips busy, disconnected or still-held terminals.
    return result.terminals
      .filter(
        (t) =>
          t.handle !== coordinatorHandle &&
          t.connected &&
          t.writable &&
          takesNewWork(db, { assigneeHandle: t.handle, ...assigneeAuthority(runtime, t.handle) })
      )
      .map((t) => t.handle)
  } catch {
    // A failed census cannot authorize creating another worker.
    return null
  }
}

export async function dispatchTaskToWorker(params: {
  db: OrchestrationDb
  runtime: CoordinatorRuntime
  task: TaskRow
  targetHandle: string
  baseDrift: WorktreeDrift
  coordinatorHandle: string
  worktree: string | undefined
  onLog: (msg: string) => void
  // Return circuit breaks to the coordinator that owns the failed-task list.
  onCircuitBroken: (taskId: string) => void
  nestedWorkerMaxDepth: number
}): Promise<TaskDispatchResult> {
  const { db, runtime, task, targetHandle, baseDrift, onLog } = params
  // Refuse stale bases before creating dispatch context so recoverable drift cannot consume circuit-breaker budget.
  const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(task.spec)

  if (!params.worktree) {
    // Without a worktree selector, drift cannot be probed.
    onLog(`stale-base guard inert for ${task.id}: coordinator has no worktree selector`)
  } else if (baseDrift && baseDrift.behind > DISPATCH_STALE_THRESHOLD && !allowStale) {
    onLog(
      `Skipping dispatch of ${task.id}: worktree is ${baseDrift.behind} commits ` +
        `behind ${baseDrift.base}. Pull/rebase the worktree, recreate it with ` +
        `--base-branch ${baseDrift.base}, or include 'allow-stale-base: true' ` +
        `in the task spec to override. Task remains in 'ready'; coordinator ` +
        `will retry on the next tick.`
    )
    return 'stale-base-refused'
  }

  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: targetHandle,
    ...assigneeAuthority(runtime, targetHandle),
    // This authenticated host-local loop is a system root, independent of CLI callers.
    creator: { kind: 'system' },
    maxDepth: params.nestedWorkerMaxDepth
  })

  // Dev workers need orca-dev to reach the dev socket.
  const preamble = buildDispatchPreamble({
    taskId: task.id,
    dispatchId: dispatch.id,
    canDispatchSubWorkers: dispatch.depth < params.nestedWorkerMaxDepth,
    taskSpec: strippedSpec,
    coordinatorHandle: params.coordinatorHandle,
    workerHandle: targetHandle,
    devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev'),
    ...(runtime.getTerminalOrchestrationCliCommand
      ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(targetHandle) }
      : {}),
    ...(baseDrift ? { baseDrift } : {})
  })

  const gates = db.listGates({ taskId: task.id, status: 'resolved' })
  let gateContext = ''
  if (gates.length > 0) {
    const latest = gates.at(-1)!
    gateContext = `\n\n--- DECISION GATE RESOLVED ---\nQuestion: ${latest.question}\nResolution: ${latest.resolution}\n\n---\n`
  }

  try {
    await sendAgentTurn({
      kind: 'terminal',
      runtime,
      handle: targetHandle,
      turn: { purpose: 'dispatch-preamble', body: preamble + gateContext, operationId: dispatch.id }
    })
  } catch (err) {
    // Enter may already have landed; an unobserved turn must not requeue the preamble or revoke worker_done authority (#16095).
    if (isAgentPromptStalledError(err)) {
      onLog(
        `Dispatched task ${task.id} to ${targetHandle}; turn start was not observed. ` +
          `The preamble is already in the pane, so the dispatch stays active instead of being resent.`
      )
      return 'dispatched-unobserved'
    }
    const updated = db.failDispatch(dispatch.id, err instanceof Error ? err.message : String(err))
    if (updated?.status === 'circuit_broken') {
      params.onCircuitBroken(task.id)
    }
    throw err
  }

  onLog(`Dispatched task ${task.id} to ${targetHandle}`)
  return 'dispatched'
}
