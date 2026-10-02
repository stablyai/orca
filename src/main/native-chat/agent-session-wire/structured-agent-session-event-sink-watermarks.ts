// How much a chat's event sink queues before it pauses the provider's stream, and the hard caps.

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

export const DEFAULT_STRUCTURED_AGENT_SESSION_SINK_WATERMARKS: StructuredAgentSessionSinkWatermarks =
  {
    pauseQueuedBytes: 16 * 1024 * 1024,
    maxQueuedBytes: 32 * 1024 * 1024,
    lowQueuedBytes: 8 * 1024 * 1024,
    pauseQueuedOperations: 512,
    maxQueuedOperations: 1_024,
    lowQueuedOperations: 256,
    maxLifecycleQueuedBytes: 16 * 1024 * 1024,
    maxLifecycleQueuedOperations: 1_024
  }
