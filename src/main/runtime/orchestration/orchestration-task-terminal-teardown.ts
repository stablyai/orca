import type { RuntimeTerminalClose } from '../../../shared/runtime-terminal-contracts'
import {
  describeUnconfirmedAgentStop,
  describeUnconfirmedStop
} from '../../../shared/pty-liveness-verdict'
import { isStructuredWorkerHandle } from '../structured-worker-identity'
import type { OrchestrationDb } from './db'
import type { OrchestrationTaskTerminalEvent } from './orchestration-task-terminal-event'
import type { TaskStatus } from './types'

export const TERMINAL_STILL_LIVE_ERROR =
  'The agent process is still live after the orchestration task finished.'

type TerminalInspection = {
  status: 'unattached' | 'missing' | 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  reason?: string
  terminalHandle: string | null
}

type WorkspaceUpdate = {
  workspaceStatus?: 'completed' | 'failed'
  isArchived?: boolean
  comment?: string
}

export type TaskTerminalTeardownPorts = {
  inspect(dispatchId: string): Promise<TerminalInspection>
  closeTerminal(handle: string): Promise<RuntimeTerminalClose>
  stopStructured(dispatchId: string): Promise<{ stopped: boolean; reason?: string }>
  releaseFederated(dispatchId: string): Promise<{ provedExited: boolean; error: string | null }>
  readWorktreeComment(worktreeId: string): Promise<string> | string
  applyWorkspace(worktreeId: string, update: WorkspaceUpdate): Promise<void>
}

type ReapResult = { provedExited: boolean; error: string | null }

export async function teardownOrchestrationTaskTerminal(
  db: OrchestrationDb,
  event: OrchestrationTaskTerminalEvent,
  ports: TaskTerminalTeardownPorts
): Promise<ReapResult> {
  const reap = await reapDispatchTerminal(db, event.dispatchId, ports)
  const worktreeId = boundWorktreeId(db, event.dispatchId)
  if (!reap.provedExited && reap.error) {
    recordVisibleTerminalFailure(db, event, reap.error)
    if (worktreeId) {
      await writeWorkspaceError(ports, worktreeId, reap.error)
    }
    return reap
  }
  const update = workspaceUpdateFor(db, event)
  if (worktreeId && update) {
    try {
      await ports.applyWorkspace(worktreeId, update)
    } catch (error) {
      const message = describeUnconfirmedStop(
        error instanceof Error ? error.message : 'the worktree status was not updated'
      )
      recordVisibleTerminalFailure(db, event, message)
      return { provedExited: true, error: message }
    }
  }
  return reap
}

async function reapDispatchTerminal(
  db: OrchestrationDb,
  dispatchId: string,
  ports: TaskTerminalTeardownPorts
): Promise<ReapResult> {
  if (db.getFederatedDispatch(dispatchId)) {
    return ports.releaseFederated(dispatchId)
  }
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  if (resource && resource.ownership_state !== 'owned') {
    return { provedExited: true, error: null }
  }
  if (resource?.release_state === 'released') {
    return { provedExited: true, error: null }
  }
  const worker = db.getWorkerDispatch(dispatchId)
  const handle = resource?.terminal_handle ?? worker?.agent_terminal_handle ?? null
  if (!handle) {
    return { provedExited: true, error: null }
  }
  if (isStructuredWorkerHandle(handle)) {
    const stop = await ports.stopStructured(dispatchId)
    return stop.stopped
      ? { provedExited: true, error: null }
      : {
          provedExited: false,
          error: describeUnconfirmedStop(
            stop.reason ?? 'the structured session close was not proven'
          )
        }
  }
  const before = await ports.inspect(dispatchId)
  if (before.status === 'exited' || before.status === 'unattached') {
    return { provedExited: true, error: null }
  }
  if (before.status === 'identity_changed') {
    return {
      provedExited: false,
      error: describeUnconfirmedStop('the terminal identity changed')
    }
  }
  const closeHandle = before.terminalHandle ?? handle
  let close: RuntimeTerminalClose | undefined
  let closeError: string | undefined
  try {
    close = await ports.closeTerminal(closeHandle)
  } catch (error) {
    closeError = error instanceof Error ? error.message : String(error)
  }
  const after = await ports.inspect(dispatchId)
  return classifyReap(before.status, after, close, closeError)
}

function classifyReap(
  before: TerminalInspection['status'],
  after: TerminalInspection,
  close: RuntimeTerminalClose | undefined,
  closeError: string | undefined
): ReapResult {
  if (after.status === 'live' || close?.ptyStopVerdict === 'live') {
    return { provedExited: false, error: TERMINAL_STILL_LIVE_ERROR }
  }
  if (after.status === 'exited' || after.status === 'unattached') {
    return { provedExited: true, error: null }
  }
  if (after.status === 'unverifiable' || close?.ptyStopVerdict === 'unverifiable') {
    return {
      provedExited: false,
      error: describeUnconfirmedStop(
        after.reason ?? close?.ptyStopReason ?? 'the stop outcome could not be verified'
      )
    }
  }
  if (close?.ptyKilled && after.status === 'missing' && before === 'live') {
    return { provedExited: true, error: null }
  }
  if (close && !close.ptyKilled) {
    return { provedExited: false, error: describeUnconfirmedAgentStop(close) }
  }
  return {
    provedExited: false,
    error: describeUnconfirmedStop(
      closeError ??
        (after.status === 'identity_changed'
          ? 'the terminal identity changed'
          : 'the terminal could not be found')
    )
  }
}

function workspaceUpdateFor(
  db: OrchestrationDb,
  event: OrchestrationTaskTerminalEvent
): WorkspaceUpdate | null {
  if (event.kind === 'completed') {
    return { workspaceStatus: 'completed' }
  }
  if (event.kind === 'failed') {
    return { workspaceStatus: 'failed' }
  }
  const task = db.getTask(event.taskId)
  if (!task || retryableTask(task.status)) {
    return null
  }
  if (task.status === 'completed') {
    return { workspaceStatus: 'completed' }
  }
  if (task.status === 'failed') {
    return { workspaceStatus: 'failed' }
  }
  return { isArchived: true }
}

function retryableTask(status: TaskStatus): boolean {
  return (
    status === 'pending' || status === 'ready' || status === 'dispatched' || status === 'blocked'
  )
}

function boundWorktreeId(db: OrchestrationDb, dispatchId: string): string | null {
  return (
    db.getWorkerTerminalResourceByOwner(dispatchId)?.worktree_id ??
    db.getWorkerDispatch(dispatchId)?.worktree_id ??
    null
  )
}

function recordVisibleTerminalFailure(
  db: OrchestrationDb,
  event: OrchestrationTaskTerminalEvent,
  message: string
): void {
  const dispatch = db.getDispatchContextById(event.dispatchId)
  if (
    dispatch &&
    (dispatch.status === 'completed' ||
      dispatch.status === 'failed' ||
      dispatch.status === 'circuit_broken')
  ) {
    safeTransition(() => {
      db.transitionLifecycle({
        entity: 'dispatch',
        id: event.dispatchId,
        from: dispatch.status,
        to: dispatch.status,
        projection: { last_failure: message }
      })
    })
  }
  const worker = db.getWorkerDispatch(event.dispatchId)
  if (worker) {
    safeTransition(() => {
      db.transitionLifecycle({
        entity: 'worker',
        id: event.dispatchId,
        from: worker.state,
        to: worker.state,
        projection: { last_error: message, updated_at: new Date().toISOString() }
      })
    })
  }
  const task = db.getTask(event.taskId)
  if (task && (task.status === 'completed' || task.status === 'failed')) {
    safeTransition(() => {
      db.transitionLifecycle({
        entity: 'task',
        id: event.taskId,
        from: task.status,
        to: task.status,
        projection: { result: taskResultWithTerminalError(task.result, message) }
      })
    })
  }
}

function taskResultWithTerminalError(result: string | null, message: string): string {
  if (!result) {
    return JSON.stringify({ terminalTeardownError: message })
  }
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, terminalTeardownError: message })
    }
  } catch {
    // Plain text results stay readable with the error on the next line.
  }
  return result.includes(message) ? result : `${result}\n${message}`
}

async function writeWorkspaceError(
  ports: TaskTerminalTeardownPorts,
  worktreeId: string,
  message: string
): Promise<void> {
  const previous = (await ports.readWorktreeComment(worktreeId)).trim()
  const comment = previous.includes(message)
    ? previous
    : previous
      ? `${previous}\n${message}`
      : message
  try {
    await ports.applyWorkspace(worktreeId, { comment })
  } catch (error) {
    console.warn(
      '[orchestration] worktree error was not saved',
      worktreeId,
      error instanceof Error ? error.message : error
    )
  }
}

function safeTransition(write: () => void): void {
  try {
    write()
  } catch (error) {
    console.warn(
      '[orchestration] task terminal error was not saved',
      error instanceof Error ? error.message : error
    )
  }
}
