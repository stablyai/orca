import type { DaemonEvent } from '../../protocol/daemon-stream-events'

// Keep control events at their stream position; empty payloads do not exempt their metadata from backpressure.
export type StreamQueueEntry = {
  sessionId: string
  data: string
  /** Source PTY characters represented; salvaged query copies advance the stream by zero. */
  sequenceChars?: number
  seq?: number
  transformed?: boolean
  control?: DaemonEvent
  retainedBytes?: number
}

export type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: StreamQueueEntry[]
  queuedChars: number
  // Track each session so small replies can bypass other sessions' held floods.
  queuedCharsBySession: Map<string, number>
  queuedMetadataBytesBySession: Map<string, number>
  // Cache membership to keep steady-state enqueue constant-time.
  droppableQueuedSessionIds: Set<string>
  // Growth tightens the shared budget, requiring re-trimming even sessions that stopped producing.
  lastEvaluatedDroppableSessionCount?: number
}

export function createPendingStreamDataBatch(): PendingStreamDataBatch {
  return {
    timer: null,
    queue: [],
    queuedChars: 0,
    queuedCharsBySession: new Map(),
    queuedMetadataBytesBySession: new Map(),
    droppableQueuedSessionIds: new Set()
  }
}
