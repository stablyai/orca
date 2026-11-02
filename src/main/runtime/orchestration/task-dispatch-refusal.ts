import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import type { TaskRow } from './types'
import {
  injectRejectedRefusal,
  taskNotFoundRefusal,
  taskNotStartableRefusal,
  type DispatchRefusalReceipt,
  type InjectRejectionReason
} from '../../../shared/orchestration-dispatch-refusal-contract'

// Callers retain their published wording while code and structured error data are shared.

export function taskNotFoundError(
  message: string,
  detail: { taskId: string; runId?: string }
): OrchestrationError {
  return toError(taskNotFoundRefusal(message, detail))
}

export function taskNotStartableError(
  db: OrchestrationDb,
  message: string,
  task: TaskRow,
  retryOf?: string,
  failureCount?: number
): OrchestrationError {
  return toError(
    taskNotStartableRefusal(message, {
      taskId: task.id,
      status: task.status,
      unmetDependencies: unmetTaskDependencies(db, task),
      ...(retryOf ? { retryOf } : {}),
      ...(failureCount !== undefined ? { failureCount } : {})
    })
  )
}

export function injectRejectedError(
  terminal: string,
  reason: InjectRejectionReason
): OrchestrationError {
  return toError(injectRejectedRefusal(terminal, reason))
}

function toError(receipt: DispatchRefusalReceipt): OrchestrationError {
  return new OrchestrationError(receipt.code, receipt.message, receipt.data)
}

function unmetTaskDependencies(db: OrchestrationDb, task: TaskRow): string[] {
  let deps: unknown
  try {
    deps = JSON.parse(task.deps)
  } catch {
    return []
  }
  if (!Array.isArray(deps)) {
    return []
  }
  return deps.filter(
    (dep): dep is string => typeof dep === 'string' && db.getTask(dep)?.status !== 'completed'
  )
}
