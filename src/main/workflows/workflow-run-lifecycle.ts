import {
  appendWorkflowEvent,
  currentWorkflowTask,
  findWorkflowNode
} from '../../shared/workflow/workflow-run-state'
import { isWorkflowTaskSettled, type WorkflowTask } from '../../shared/workflow/workflow-run-types'
import { registerWorkflowRouteGuard } from '../runtime/orchestration/workflow-route-guard'
import { createWorkflowDirectRouteGuard } from './workflow-direct-route-guard'
import type { WorkflowRunSession } from './workflow-run-session'
import { WorkflowRequestError } from './workflow-request-error'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function armRouteGuard(session: WorkflowRunSession): void {
  if (session.run.orcaRunId && !session.unregisterRouteGuard) {
    session.unregisterRouteGuard = registerWorkflowRouteGuard(
      session.run.orcaRunId,
      createWorkflowDirectRouteGuard(session)
    )
  }
}

/**
 * Create (or, after a crash, re-find through replayed request ids) the coordinator terminal and the
 * Orca Run, then hand control to the scheduler.
 */
export async function launchWorkflowRun(session: WorkflowRunSession): Promise<void> {
  const { run, deps } = session
  try {
    let handle = run.coordinatorTerminalHandle
    if (handle && !deps.adapter.terminalExists(handle)) {
      handle = null
    }
    if (!handle) {
      handle = await deps.adapter.createCoordinatorTerminal({
        worktreeSelector: run.placement.worktreeSelector,
        title: `Workflow · ${run.presetName}`,
        requestId: `${run.id}:coordinator:${run.events.length}`
      })
      const created = handle
      const rebind = run.orcaRunId !== null
      await session.exclusive(() => {
        run.coordinatorTerminalHandle = created
        session.persist()
      })
      if (rebind && run.orcaRunId) {
        await deps.adapter.rebindRun({
          from: created,
          orcaRunId: run.orcaRunId,
          requestId: `${run.id}:rebind:${created}`
        })
      }
    }
    if (!run.orcaRunId) {
      const orcaRunId = await deps.adapter.createRun({
        from: handle,
        objective: `${run.presetName}: ${run.objective}`.slice(0, 4_000),
        requestId: `${run.id}:run`
      })
      await session.exclusive(() => {
        run.orcaRunId = orcaRunId
        session.persist()
      })
    }
  } catch (error) {
    await session.exclusive(() => {
      run.status = 'failed'
      run.error = `Could not start the workflow in Orca: ${errorText(error)}`
      run.settledAt = session.at()
      appendWorkflowEvent(run, 'run-failed', session.at(), run.error)
      session.persist()
    })
    session.close()
    return
  }
  await session.exclusive(() => {
    armRouteGuard(session)
    if (!run.startedAt) {
      run.startedAt = session.at()
      appendWorkflowEvent(
        run,
        'run-started',
        session.at(),
        `Run started in ${run.placement.worktreeLabel}; Orca Run ${run.orcaRunId}.`
      )
    }
    session.persist()
  })
  session.startObserving()
  await session.schedule()
}

/** After a restart: rebind, replay in-flight starts by their request ids, then reconcile. */
export async function recoverWorkflowRun(session: WorkflowRunSession): Promise<void> {
  await session.exclusive(() => {
    appendWorkflowEvent(
      session.run,
      'run-reconciled',
      session.at(),
      'Orca restarted; reconciling this run with Orca’s records.'
    )
    for (const task of Object.values(session.run.tasks)) {
      const dispatch = task.dispatches.at(-1)
      // A start that never returned is replayed with the same request id, which cannot duplicate it.
      if (
        (task.status === 'dispatched' || task.status === 'unknown') &&
        dispatch &&
        !dispatch.orcaDispatchId
      ) {
        task.dispatches.pop()
        task.status = 'ready'
      }
    }
    session.persist()
  })
  await launchWorkflowRun(session)
}

export async function requestWorkflowApproval(
  session: WorkflowRunSession,
  taskKey: string
): Promise<void> {
  const { run, deps } = session
  const task = run.tasks[taskKey]
  const node = task ? findWorkflowNode(run.definition, task.nodeId) : null
  if (
    !task ||
    !node ||
    node.kind !== 'approval' ||
    !run.coordinatorTerminalHandle ||
    !run.orcaRunId
  ) {
    return
  }
  let gateId: string | null = null
  let orcaTaskId = task.orcaTaskId
  try {
    orcaTaskId ??= await deps.adapter.createTask({
      from: run.coordinatorTerminalHandle,
      orcaRunId: run.orcaRunId,
      spec: `Human approval: ${node.question}`,
      title: `wf:${run.id}:${task.key}`,
      displayName: node.label,
      requestId: `${run.id}:${task.key}:task`
    })
    gateId = await deps.adapter.createGate({
      from: run.coordinatorTerminalHandle,
      orcaRunId: run.orcaRunId,
      orcaTaskId,
      question: node.question,
      requestId: `${run.id}:${task.key}:gate`
    })
  } catch (error) {
    await session.exclusive(() =>
      session.warn(
        `Orca gate for ${node.label} was not created (${errorText(error)}); approve it here.`,
        { task }
      )
    )
  }
  await session.exclusive(() => {
    task.orcaTaskId = orcaTaskId
    task.approval = { gateId, resolution: null }
    appendWorkflowEvent(
      run,
      'approval-requested',
      session.at(),
      `${node.label}: ${node.question}`,
      { task }
    )
    session.persist()
  })
}

/** Guarded stop of a task's live worker; resolves true only when Orca proves it stopped. */
export async function stopWorkflowTask(
  session: WorkflowRunSession,
  task: WorkflowTask,
  reason: string
): Promise<boolean> {
  const dispatch = task.dispatches.at(-1)
  let state = 'stopped'
  if (dispatch?.orcaDispatchId && (task.status === 'running' || task.status === 'unknown')) {
    try {
      state = await session.deps.adapter.stopWorker({
        dispatchId: dispatch.orcaDispatchId,
        requestId: `${dispatch.requestId}:stop`
      })
    } catch (error) {
      state = `refused: ${errorText(error)}`
    }
  }
  return session.exclusive(() => {
    const proven = state === 'stopped' || state === 'succeeded' || state === 'failed'
    if (dispatch && dispatch.state !== 'succeeded' && dispatch.state !== 'failed') {
      dispatch.state = proven ? 'stopped' : 'unknown'
      dispatch.settledAt = session.at()
    }
    task.status = proven ? 'cancelled' : 'unknown'
    task.settledAt = session.at()
    task.error = proven ? reason : `${reason} Orca could not prove the worker stopped (${state}).`
    session.persist()
    return proven
  })
}

/** A worker that stopped without reporting still holds its Dispatch; stop it before a new attempt. */
export async function stopRunningTaskForRetry(
  session: WorkflowRunSession,
  taskKey: string
): Promise<void> {
  const task = session.run.tasks[taskKey]
  if (
    task?.status === 'running' &&
    !(await stopWorkflowTask(session, task, 'Stopped for retry.'))
  ) {
    throw new WorkflowRequestError(
      'worker_stop_unproven',
      'Orca could not prove the worker stopped, so no second attempt was started.'
    )
  }
}

/** Stop what is still running; uncertain stops stay visible as unknown rather than claimed. */
export async function cancelWorkflowRun(
  session: WorkflowRunSession,
  reason: string
): Promise<void> {
  const { run } = session
  const live = await session.exclusive(() => {
    run.status = 'cancelling'
    run.schedulingPaused = true
    appendWorkflowEvent(run, 'run-cancel-requested', session.at(), reason)
    session.persist()
    return run.definition.nodes
      .map((node) => currentWorkflowTask(run, node.id))
      .filter((task) => !isWorkflowTaskSettled(task.status))
  })
  await Promise.all(live.map((task) => stopWorkflowTask(session, task, reason)))
  await session.exclusive(() => {
    const uncertain = Object.values(run.tasks).filter((task) => task.status === 'unknown').length
    run.status = 'cancelled'
    run.settledAt = session.at()
    appendWorkflowEvent(
      run,
      'run-cancelled',
      session.at(),
      uncertain > 0
        ? `Cancelled; ${uncertain} worker(s) could not be proven stopped.`
        : 'Cancelled; every worker stopped.'
    )
    session.persist()
  })
  await releaseCoordinator(session)
}

/** After the scheduler settles the run: stop stragglers (fail-fast) and close the coordinator terminal. */
export async function finalizeWorkflowRun(session: WorkflowRunSession): Promise<void> {
  const live = await session.exclusive(() =>
    session.run.definition.nodes
      .map((node) => currentWorkflowTask(session.run, node.id))
      .filter((task) => task.status === 'running' || task.status === 'unknown')
  )
  await Promise.all(
    live.map((task) =>
      stopWorkflowTask(session, task, 'The workflow ended before this task finished.')
    )
  )
  await releaseCoordinator(session)
}

async function releaseCoordinator(session: WorkflowRunSession): Promise<void> {
  const handle = session.run.coordinatorTerminalHandle
  session.close()
  if (handle && session.deps.adapter.terminalExists(handle)) {
    await session.deps.adapter.closeTerminal(handle).catch((error: unknown) => {
      console.warn('[workflows] could not close coordinator terminal', handle, error)
    })
  }
}
