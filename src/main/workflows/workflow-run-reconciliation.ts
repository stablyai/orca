import { isWorkflowAgentNode } from '../../shared/workflow/workflow-definition-schema'
import {
  appendWorkflowEvent,
  currentWorkflowTask,
  findWorkflowNode
} from '../../shared/workflow/workflow-run-state'
import {
  completeWorkflowTask,
  failWorkflowTaskAttempt
} from '../../shared/workflow/workflow-task-settlement'
import { parseWorkflowTaskResult } from '../../shared/workflow/workflow-worker-result'
import type { WorkflowDispatch, WorkflowTask } from '../../shared/workflow/workflow-run-types'
import type { WorkflowRunSession } from './workflow-run-session'

const ENDED_WORKER_STATES = new Set(['failed', 'stopped', 'abandoned'])

type TimedOut = { task: WorkflowTask; dispatch: WorkflowDispatch; limitMs: number }

/** Settle from Orca's own Task and Dispatch rows; mail only wakes this sooner. */
function reconcileTurn(session: WorkflowRunSession): TimedOut[] {
  const { run, deps } = session
  const at = session.at()
  const now = Date.parse(at)
  const timedOut: TimedOut[] = []
  for (const node of run.definition.nodes) {
    if (!isWorkflowAgentNode(node)) {
      continue
    }
    const task = currentWorkflowTask(run, node.id)
    const dispatch = task.dispatches.at(-1)
    if (!dispatch?.orcaDispatchId || !task.orcaTaskId) {
      continue
    }
    if (task.status !== 'running' && task.status !== 'unknown') {
      continue
    }
    const orcaTask = deps.adapter.readTask(task.orcaTaskId)
    const snapshot = deps.adapter.readDispatch(dispatch.orcaDispatchId)
    const refs = {
      task,
      orcaDispatchId: dispatch.orcaDispatchId,
      correlationId: dispatch.requestId
    }
    // Orca settles the Task only for the active Dispatch, so a stale attempt's report never lands here.
    if (orcaTask && (orcaTask.status === 'completed' || orcaTask.status === 'failed')) {
      const report = parseWorkflowTaskResult(
        orcaTask.result,
        orcaTask.status === 'completed' ? 'succeeded' : 'failed'
      )
      dispatch.state = report.outcome === 'succeeded' ? 'succeeded' : 'failed'
      dispatch.settledAt = at
      if (
        node.agent.prompt.outputFormat === 'json' &&
        report.outcome === 'succeeded' &&
        report.dataError
      ) {
        session.warn(`${node.label}: ${report.dataError}`, refs)
      }
      if (completeWorkflowTask(run, task.key, report, at) === 'stale') {
        session.warn(
          `Ignored a report for ${node.label} that no longer matches its active attempt.`,
          refs
        )
      }
      continue
    }
    if (
      snapshot &&
      (ENDED_WORKER_STATES.has(snapshot.workerState ?? '') ||
        snapshot.status === 'failed' ||
        snapshot.status === 'circuit_broken')
    ) {
      dispatch.state = snapshot.workerState === 'stopped' ? 'stopped' : 'failed'
      dispatch.settledAt = at
      dispatch.error =
        snapshot.lastFailure ??
        `The worker ${snapshot.workerState ?? snapshot.status} without reporting.`
      failWorkflowTaskAttempt(run, task.key, dispatch.error, at)
      continue
    }
    if (
      task.status === 'unknown' &&
      snapshot &&
      (snapshot.workerState === 'ready' || snapshot.workerState === 'starting')
    ) {
      task.status = 'running'
      dispatch.state = 'running'
      task.startedAt ??= at
      appendWorkflowEvent(
        run,
        'agent-started',
        at,
        `${node.label} confirmed running after reconciliation.`,
        refs
      )
      continue
    }
    const limit = node.agent.execution.timeoutMs
    if (
      limit !== null &&
      task.status === 'running' &&
      now - Date.parse(dispatch.startedAt) > limit
    ) {
      timedOut.push({ task, dispatch, limitMs: limit })
    }
  }
  return timedOut
}

export async function reconcileWorkflowRun(session: WorkflowRunSession): Promise<void> {
  if (session.isClosed || session.terminal) {
    return
  }
  const timedOut = await session.exclusive(() => {
    const found = reconcileTurn(session)
    session.persist()
    return found
  })
  for (const { task, dispatch, limitMs } of timedOut) {
    let stopState = 'unknown'
    try {
      stopState = await session.deps.adapter.stopWorker({
        dispatchId: dispatch.orcaDispatchId ?? '',
        requestId: `${dispatch.requestId}:timeout-stop`
      })
    } catch (error) {
      stopState = `stop refused: ${error instanceof Error ? error.message : String(error)}`
    }
    await session.exclusive(() => {
      const label = findWorkflowNode(session.run.definition, task.nodeId).label
      dispatch.state = stopState === 'stopped' ? 'stopped' : 'unknown'
      dispatch.settledAt = session.at()
      if (stopState !== 'stopped') {
        session.warn(
          `${label} timed out; Orca could not prove the worker stopped (${stopState}).`,
          { task }
        )
      }
      failWorkflowTaskAttempt(
        session.run,
        task.key,
        `Timed out after ${Math.round(limitMs / 1000)}s.`,
        session.at()
      )
      session.persist()
    })
  }
  const maxDuration = session.run.definition.policies.maxRunDurationMs
  const overDuration = 'The workflow exceeded its maximum run duration.'
  if (
    maxDuration !== null &&
    session.run.startedAt &&
    Date.now() - Date.parse(session.run.startedAt) > maxDuration &&
    !session.run.events.some((event) => event.message === overDuration)
  ) {
    await session.exclusive(() => session.warn(overDuration))
  }
  await session.schedule()
}
