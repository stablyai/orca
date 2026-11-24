import type { WorkerTabStamp } from '../../../../../shared/orchestration/workers/worker-tab-stamp'

// Held from create until the worker's session is forgotten, so every publication of its chat tab carries it.
const stampsBySessionId = new Map<string, WorkerTabStamp>()

export function rememberStructuredWorkerTabStamp(sessionId: string, stamp: WorkerTabStamp): void {
  stampsBySessionId.set(sessionId, stamp)
}

export function forgetStructuredWorkerTabStamp(sessionId: string): void {
  stampsBySessionId.delete(sessionId)
}

export function structuredWorkerTabStamp(sessionId: string): WorkerTabStamp | undefined {
  return stampsBySessionId.get(sessionId)
}
