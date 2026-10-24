export type StructuredAgentSessionSinkAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' }

export type StructuredAgentSessionSinkState = {
  queuedBytes: number
  queuedOperations: number
  backpressured: boolean
  failed: boolean
}

export type StructuredAgentSessionSinkBarrier = { ok: true } | { ok: false; error: unknown }

export type StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: number
  maxQueuedBytes: number
  lowQueuedBytes: number
  pauseQueuedOperations: number
  maxQueuedOperations: number
  lowQueuedOperations: number
  maxLifecycleQueuedBytes: number
  maxLifecycleQueuedOperations: number
}

export const DEFAULT_WATERMARKS: StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: 16 * 1024 * 1024,
  maxQueuedBytes: 32 * 1024 * 1024,
  lowQueuedBytes: 8 * 1024 * 1024,
  pauseQueuedOperations: 512,
  maxQueuedOperations: 1_024,
  lowQueuedOperations: 256,
  maxLifecycleQueuedBytes: 16 * 1024 * 1024,
  maxLifecycleQueuedOperations: 1_024
}
