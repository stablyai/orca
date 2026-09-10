import { OrchestrationError } from '../../orchestration-error'
import type { RunCompletion, RunCompletionWaiver } from '../../types'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { OrchestrationDb } from '../orchestration-db'

type RunCompletionRow = {
  run_id: string
  summary: string
  evidence_json: string
  waivers_json: string
  completed_by_handle: string
  completed_by_pane_key: string
  completed_by_generation: number
  completed_at: string
}

const RUN_COMPLETION_COLUMNS = [
  'run_id',
  'summary',
  'evidence_json',
  'waivers_json',
  'completed_by_handle',
  'completed_by_pane_key',
  'completed_by_generation',
  'completed_at'
].join(', ')

export type CompleteRunParams = {
  runId: string
  summary: string
  evidence: string[]
  waivers: RunCompletionWaiver[]
  coordinatorHandle: string
  coordinatorPaneKey: string
  coordinatorGeneration: number
}

export type RunCompletionReceipt = {
  completion: RunCompletion
  duplicate: boolean
}

export function getRunCompletion(this: OrchestrationDb, runId: string): RunCompletion | undefined {
  const row = this.db
    .prepare(`SELECT ${RUN_COMPLETION_COLUMNS} FROM run_completions WHERE run_id = ?`)
    .get(runId) as RunCompletionRow | undefined
  return row ? exposeCompletion(row) : undefined
}

export function completeRun(
  this: OrchestrationDb,
  params: CompleteRunParams
): RunCompletionReceipt {
  return runLifecycleWriteTransaction(this.db, 'complete_run', () => {
    const run = this.getRun(params.runId)
    if (!run || run.legacy === 1) {
      throw new OrchestrationError('run_not_found', `Run ${params.runId} was not found.`)
    }
    if (
      run.coordinator_handle !== params.coordinatorHandle ||
      run.coordinator_pane_key !== params.coordinatorPaneKey ||
      run.consumer_generation !== params.coordinatorGeneration
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Run ${params.runId} is no longer owned by coordinator generation ${params.coordinatorGeneration}.`,
        { effectsApplied: false }
      )
    }

    const summary = params.summary.trim()
    const evidence = params.evidence.map((entry) => entry.trim())
    const waivers = [...params.waivers]
      .map((waiver) => ({ task_id: waiver.task_id.trim(), reason: waiver.reason.trim() }))
      .sort((left, right) =>
        left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0
      )
    if (!summary || evidence.length === 0 || evidence.some((entry) => !entry)) {
      throw new OrchestrationError(
        'invalid_argument',
        'Run completion requires a non-empty summary and at least one non-empty evidence item.'
      )
    }
    if (waivers.some((waiver) => !waiver.task_id || !waiver.reason)) {
      throw new OrchestrationError(
        'invalid_argument',
        'Every completion waiver requires an exact Task id and a non-empty reason.'
      )
    }
    const existing = this.db
      .prepare(`SELECT ${RUN_COMPLETION_COLUMNS} FROM run_completions WHERE run_id = ?`)
      .get(params.runId) as RunCompletionRow | undefined
    if (existing) {
      const completion = exposeCompletion(existing)
      if (
        completion.summary === summary &&
        JSON.stringify(completion.evidence) === JSON.stringify(evidence) &&
        JSON.stringify(completion.waivers) === JSON.stringify(waivers)
      ) {
        return { completion, duplicate: true }
      }
      throw new OrchestrationError(
        'run_already_completed',
        `Run ${params.runId} was already completed at ${completion.completed_at}.`,
        { effectsApplied: false, completion }
      )
    }

    const unresolved = this.listTasks({ runId: params.runId }).filter(
      (task) => task.purpose !== 'operational' && task.status !== 'completed'
    )
    const unresolvedIds = new Set(unresolved.map((task) => task.id))
    const waivedIds = new Set<string>()
    for (const waiver of waivers) {
      if (waivedIds.has(waiver.task_id)) {
        throw new OrchestrationError(
          'invalid_argument',
          `Task ${waiver.task_id} has more than one completion waiver.`
        )
      }
      if (!unresolvedIds.has(waiver.task_id)) {
        throw new OrchestrationError(
          'invalid_argument',
          `Completion waiver ${waiver.task_id} does not name unresolved required work in Run ${params.runId}.`
        )
      }
      waivedIds.add(waiver.task_id)
    }
    const blockingTaskIds = unresolved
      .map((task) => task.id)
      .filter((taskId) => !waivedIds.has(taskId))
    if (blockingTaskIds.length > 0) {
      throw new OrchestrationError(
        'run_incomplete',
        `Run ${params.runId} still has ${blockingTaskIds.length} required Task${blockingTaskIds.length === 1 ? '' : 's'} pending.`,
        { effectsApplied: false, blockingTaskIds }
      )
    }

    const completedAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO run_completions (
           run_id, summary, evidence_json, waivers_json, completed_by_handle,
           completed_by_pane_key, completed_by_generation, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.runId,
        summary,
        JSON.stringify(evidence),
        JSON.stringify(waivers),
        params.coordinatorHandle,
        params.coordinatorPaneKey,
        params.coordinatorGeneration,
        completedAt
      )
    return {
      completion: this.getRunCompletion(params.runId) as RunCompletion,
      duplicate: false
    }
  })
}

function exposeCompletion(row: RunCompletionRow): RunCompletion {
  return {
    run_id: row.run_id,
    summary: row.summary,
    evidence: parseArray<string>(row.evidence_json, row.run_id, 'evidence'),
    waivers: parseArray<RunCompletionWaiver>(row.waivers_json, row.run_id, 'waivers'),
    completed_by_handle: row.completed_by_handle,
    completed_by_generation: row.completed_by_generation,
    completed_at: row.completed_at
  }
}

function parseArray<T>(value: string, runId: string, field: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed as T[]
    }
  } catch {
    // Report the durable corruption below with the Run identity.
  }
  throw new Error(`Stored ${field} for Run ${runId} is invalid.`)
}

export type RunCompletionMethods = {
  getRunCompletion: typeof getRunCompletion
  completeRun: typeof completeRun
}

export function attachRunCompletion(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { getRunCompletion, completeRun })
}
