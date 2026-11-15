import type { RunRow, TaskRow } from '../../../../orchestration/db/orchestration-records'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { taskNotFoundError } from '../../../../orchestration/coordinator/dispatch/task-dispatch-refusal'
import { resolveRunScope } from '../runs/run-scope'
import { parseOrchestrationTaskDepsFlag } from '../../../../orchestration/coordinator/dispatch/task-deps-flag'
import type { OrchestrationAccessRuleInput } from './orchestration-method-access'

/** The Run a Run-scoped method acts in, under the one Run-binding rule tasks and gates share. */
export type RunAccess = { run: RunRow }

type RunScopedParams = { run?: string }

function callerRun(
  { ctx, caller }: OrchestrationAccessRuleInput<unknown>,
  runId: string | undefined,
  requireCurrentConsumer: boolean
): RunRow {
  return resolveRunScope(ctx.runtime, {
    runId,
    callerTerminalHandle: caller,
    requireCurrentConsumer,
    legacyCoordinatorRunId: ctx.legacyCoordinatorRunId,
    callerEvidence: ctx.orchestrationCompatibilityEvidence,
    callerSession: ctx.orchestrationCaller
  })
}

/** The caller must coordinate the Run it names, or be bound to one. */
export function coordinatedRunAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams>
): RunAccess {
  return { run: callerRun(input, input.params.run, true) }
}

/** An explicit Run, legacy included, is inspectable; without one the caller reads its own. */
export function inspectedRunAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams>
): RunAccess {
  const { run: runId } = input.params
  const explicit = runId ? input.ctx.runtime.getOrchestrationDb().getRun(runId) : undefined
  if (explicit?.legacy === 1) {
    return { run: explicit }
  }
  return { run: callerRun(input, runId, runId === undefined) }
}

/** Malformed --deps is refused before the Run is checked, as before. */
export function taskCreateAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams & { deps?: string }>
): RunAccess & { deps: string[] | undefined } {
  const deps = input.params.deps ? parseOrchestrationTaskDepsFlag(input.params.deps) : undefined
  return { ...coordinatedRunAccess(input), deps }
}

export function taskUpdateAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams & { id: string }>
): RunAccess {
  const { run } = coordinatedRunAccess(input)
  const existing = input.ctx.runtime.getOrchestrationDb().getTask(input.params.id)
  if (!existing || existing.run_id !== run.id) {
    throw new OrchestrationError(
      'task_not_found',
      `Task ${input.params.id} was not found in Run ${run.id}.`
    )
  }
  return { run }
}

export function dispatchAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams & { task: string }>
): RunAccess & { task: TaskRow } {
  const task = input.ctx.runtime.getOrchestrationDb().getTask(input.params.task)
  if (!task) {
    throw taskNotFoundError(`Task not found: ${input.params.task}`, { taskId: input.params.task })
  }
  const { run } = coordinatedRunAccess(input)
  if (task.run_id !== run.id) {
    throw taskNotFoundError(`Task ${task.id} was not found in Run ${run.id}.`, {
      taskId: task.id,
      runId: run.id
    })
  }
  return { run, task }
}

/** Malformed --options is refused before the Task and Run are checked, as before. */
export function gateCreateAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams & { task: string; options?: string }>
): RunAccess & { options: string[] | undefined } {
  const options = input.params.options ? parseGateOptions(input.params.options) : undefined
  const task = input.ctx.runtime.getOrchestrationDb().getTask(input.params.task)
  if (!task) {
    throw new Error(`Task not found: ${input.params.task}`)
  }
  const { run } = coordinatedRunAccess(input)
  if (task.run_id !== run.id) {
    throw taskNotFoundError(`Task ${input.params.task} was not found in Run ${run.id}.`, {
      taskId: input.params.task,
      runId: run.id
    })
  }
  return { run, options }
}

function parseGateOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((option) => typeof option === 'string')) {
      throw new Error('not an array of strings')
    }
    return parsed
  } catch {
    throw new Error('Invalid --options: must be a JSON array of strings')
  }
}

export function gateResolveAccess(
  input: OrchestrationAccessRuleInput<RunScopedParams & { id: string }>
): RunAccess {
  const existing = input.ctx.runtime.getOrchestrationDb().getGate(input.params.id)
  if (!existing) {
    throw new Error(`Gate not found: ${input.params.id}`)
  }
  const { run } = coordinatedRunAccess(input)
  // Hide foreign gates as missing so probes cannot map other Runs.
  if (existing.run_id !== run.id) {
    throw new Error(`Gate not found: ${input.params.id}`)
  }
  return { run }
}
