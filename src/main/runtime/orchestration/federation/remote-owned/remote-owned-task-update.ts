import { z } from 'zod'
import type { TaskStatus } from '../../db/orchestration-records'
import { currentRemoteAttempt, remoteHoldOnTask } from '../../db/remote-owned/remote-placements'
import { getOpenRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import {
  callRemoteOwnedServer,
  remoteForwardRequestId,
  type RemoteOwnedRuntime
} from './remote-owned-calls'

const TASK_UPDATE_TIMEOUT_MS = 30_000

/**
 * A Task a paired server still holds (its attempt runs, or its result has not come home) is updated there by its ordinary
 * taskUpdate, which owns the worker the update must respect. The Task here changes only when the
 * result comes back through the server's queue. Undefined when the Task is not held there.
 */
export async function forwardRemoteTaskUpdate(
  runtime: RemoteOwnedRuntime,
  update: { id: string; status: TaskStatus; result?: string },
  retry: { callerNamespace: string; requestId: string } | undefined
): Promise<{ task: unknown; on: string } | undefined> {
  const db = runtime.getOrchestrationDb()
  const attempt = currentRemoteAttempt(db, update.id)
  const link = attempt && getOpenRemoteRunLink(db, attempt.conversation_id)
  if (!attempt || !link || remoteHoldOnTask(db, update.id)?.dispatchId !== attempt.dispatch_id) {
    return undefined
  }
  const answer = z.object({ task: z.unknown() }).safeParse(
    await callRemoteOwnedServer(runtime, link, {
      method: 'orchestration.taskUpdate',
      params: {
        id: update.id,
        status: update.status,
        ...(update.result !== undefined ? { result: update.result } : {})
      },
      timeoutMs: TASK_UPDATE_TIMEOUT_MS,
      ...(retry
        ? { requestId: remoteForwardRequestId(retry.callerNamespace, retry.requestId) }
        : {}),
      whileLink: ['open']
    })
  )
  return {
    task: answer.success ? answer.data.task : db.getTask(update.id),
    on: runtime.resolveOrchestrationWorkerServer(link.environment_id).name
  }
}
