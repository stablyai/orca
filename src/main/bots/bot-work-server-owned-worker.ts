// A worker a paired server runs as its own (worker-start --on): known here only by this Orca's
// record of it, as worker-show reads it, never by a call there.
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration/orchestration-task-display'
import type { OrchestrationSessionWorkerState } from '../../shared/orchestration-session-workers'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  getRemoteDispatch,
  isRemoteDispatchTerminal,
  type RemoteDispatchRow
} from '../runtime/orchestration/db/remote-owned/remote-dispatch-records'
import { getRemoteRunLink } from '../runtime/orchestration/db/remote-owned/remote-run-links'
import { exposeUtcTimestamp } from '../runtime/orchestration/db/utc-timestamp'
import { remoteServerName } from '../runtime/orchestration/federation/remote-owned/remote-owned-reads'
import type { BotWorkWorker } from './bot-work-types'

type ServerOwnedRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'resolveOrchestrationWorkerServer'
>

function workerState(
  record: RemoteDispatchRow,
  reporting: boolean
): OrchestrationSessionWorkerState {
  if (!isRemoteDispatchTerminal(record)) {
    // A re-made pairing stops the server reporting it here, so its last state proves nothing.
    return reporting ? 'working' : 'unverifiable'
  }
  if (record.worker_state === null) {
    return record.status === 'completed' ? 'completed' : 'failed'
  }
  return record.worker_state === 'succeeded'
    ? 'completed'
    : record.worker_state === 'failed'
      ? 'failed'
      : 'stopped'
}

function epochMs(timestamp: string): number | null {
  const parsed = Date.parse(exposeUtcTimestamp(timestamp) ?? timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

/** The worker a server runs for this Orca's Dispatch, or null when no server runs it. */
export async function readServerOwnedWorker(
  runtime: ServerOwnedRuntime,
  dispatchId: string
): Promise<BotWorkWorker | null> {
  const db = runtime.getOrchestrationDb()
  const record = getRemoteDispatch(db, dispatchId)
  const task = record && db.getTask(record.task_id)
  if (!record || !task) {
    return null
  }
  const link = getRemoteRunLink(db, record.conversation_id)
  const state = workerState(record, link?.state !== 'closed')
  const display = buildOrchestrationTaskDisplayMetadata({
    spec: task.spec,
    taskTitle: task.task_title,
    displayName: task.display_name
  })
  return {
    dispatchId: record.dispatch_id,
    taskId: record.task_id,
    title: display.taskTitle || display.displayName || record.task_id,
    agent: record.agent,
    state,
    stopped: record.worker_state === 'stopped' || record.worker_state === 'abandoned',
    // Its Dispatch failed there before any worker ran.
    startFailed: record.worker_state === null && record.status === 'failed',
    host: record.environment_id,
    hostName: await remoteServerName(runtime, record.environment_id, link?.server_name),
    // The workspace is the server's; this Orca's record doesn't name it.
    worktreeId: null,
    startedAt: epochMs(record.created_at) ?? Date.now(),
    settledAt: state === 'working' || state === 'unverifiable' ? null : epochMs(record.updated_at)
  }
}
