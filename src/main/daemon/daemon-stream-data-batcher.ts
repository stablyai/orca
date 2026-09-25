import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import {
  accountDaemonStreamEntry,
  releaseDaemonStreamEntry
} from './daemon-stream-entry-accounting'
import { DaemonStreamHeldRefill } from './daemon-stream-held-refill'
import { clampToSafeSplitIndex, writeStreamDataEvents } from './daemon-stream-data-split'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { DaemonEvent } from './types'
import {
  appendDaemonStreamData,
  flushDaemonStreamSession,
  type DaemonStreamEnqueueOptions
} from './daemon-stream-data-entry'
import {
  evaluateDroppableEnqueue,
  refreshDroppableSessionMembership
} from './daemon-stream-droppable-membership'
import type { DaemonStreamDataBatcherOptions } from './daemon-stream-data-batcher-options'

type StreamDataClient = {
  streamSocket: Socket | null
}

// 2ms: each chunk waits a half-window here AND again in main's PTY batch; a smaller interval still coalesces bursts while cutting the fixed latency tax (~8ms of the measured ~19ms DSR-under-load latency).
const STREAM_DATA_BATCH_INTERVAL_MS = 2

// Shallow socket: the stream is one FIFO, so a deep buffer buries a visible pane's echo behind other panes' bulk; bulk stops here and is HELD (flushSession can jump it), bounding echo latency.
// 128KB stays above the socket's ~16KB highWaterMark so a held state implies a false write() and thus a guaranteed 'drain' wake-up.
const SHALLOW_SOCKET_WRITE_GATE_BYTES =
  process.env.ORCA_DAEMON_SHALLOW_SOCKET_GATE === '0' ? Number.POSITIVE_INFINITY : 128 * 1024
// Sliced writes: a coalesced entry can grow to megabytes; writing it whole would re-deepen the socket past the gate in one call.
const BULK_WRITE_SLICE_CHARS = 64 * 1024
// Last resort for handles without pause support; actual memory bounds come from producer backpressure.
const HELD_WRITE_THROUGH_TOTAL_CHARS = 32 * 1024 * 1024
// Small-session bypass: a few-KB session (echo, redraws, query replies) is never the flood, so it must not wait FIFO behind others' megabytes; backstops the 100ms interactive fast-path, which misses under event-loop load.
const SMALL_SESSION_HOLD_BYPASS_CHARS = 4 * 1024

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number
  private readonly backpressure: DaemonStreamBackpressure | undefined
  private readonly heldRefill = new DaemonStreamHeldRefill((clientId) => this.flush(clientId))
  private isSessionDroppable: (sessionId: string) => boolean
  private salvageDroppedData: (dropped: string) => string

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    const isBackgroundDroppable = options.isSessionDroppable ?? (() => false)
    // A stall-released session is droppable for as long as its backlog survives, whether or not main
    // has backgrounded it: keep-tail thinning is what lets its producer run past an unreachable client.
    this.isSessionDroppable = (sessionId) =>
      this.backpressure?.isStallReleased(sessionId) === true || isBackgroundDroppable(sessionId)
    this.salvageDroppedData = options.salvageDroppedData ?? (() => '')
    this.backpressure = options.onProducerBackpressureChanged
      ? new DaemonStreamBackpressure(
          options.onProducerBackpressureChanged,
          this.isSessionDroppable,
          options.isSessionAttachedToClient,
          (sessionId) => this.refreshSessionDroppability(sessionId)
        )
      : undefined
  }

  enqueue(
    clientId: string,
    sessionId: string,
    data: string,
    options: DaemonStreamEnqueueOptions = {}
  ): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    const batch = this.getOrCreateBatch(clientId)
    const queuedAfter = appendDaemonStreamData(batch, sessionId, data, options)
    const queuedBefore = queuedAfter - data.length
    evaluateDroppableEnqueue(
      batch,
      sessionId,
      queuedBefore,
      queuedAfter,
      this.isSessionDroppable,
      this.salvageDroppedData
    )
    this.updateBackpressure(clientId, batch)

    if (
      options.flushImmediately === true &&
      (!batch.droppableQueuedSessionIds.has(sessionId) ||
        client.streamSocket.writableLength < SHALLOW_SOCKET_WRITE_GATE_BYTES) &&
      (batch.queuedCharsBySession.get(sessionId) ?? 0) <=
        (options.flushMaxChars ?? Number.POSITIVE_INFINITY)
    ) {
      this.flushSession(clientId, sessionId)
      return
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  /** Append a pre-shaped stream event at the current position in the session's byte order (scan handoff markers, gaps, transient facts). */
  enqueueControlEvent(clientId: string, sessionId: string, control: DaemonEvent): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }
    const batch = this.getOrCreateBatch(clientId)
    batch.queue.push(accountDaemonStreamEntry(batch, { sessionId, data: '', control }))
    this.updateBackpressure(clientId, batch)
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  refreshSessionDroppability(sessionId: string): void {
    const droppable = this.isSessionDroppable(sessionId)
    refreshDroppableSessionMembership(this.pendingByClient.values(), sessionId, droppable)
    this.backpressure?.refresh()
  }

  private getOrCreateBatch(clientId: string): PendingStreamDataBatch {
    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = {
        timer: null,
        queue: [],
        queuedChars: 0,
        queuedCharsBySession: new Map(),
        queuedMetadataBytesBySession: new Map(),
        droppableQueuedSessionIds: new Set()
      }
      this.pendingByClient.set(clientId, batch)
    }
    return batch
  }

  queuedCharsForClient(clientId: string): number {
    return this.pendingByClient.get(clientId)?.queuedChars ?? 0
  }

  flush(clientId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      // A vanished stream socket drops the batch — the model owns the bytes and reconnect restores from a snapshot.
      this.clear(clientId)
      return
    }

    const socket = client.streamSocket
    // A session that held an entry must hold all its later entries this pass — writing around a held entry would reorder that session's bytes.
    const heldSessions = new Set<string>()
    const retained: PendingStreamDataBatch['queue'] = []
    while (batch.queue.length > 0) {
      const entry = batch.queue[0]
      const socketDeep = (socket.writableLength ?? 0) >= SHALLOW_SOCKET_WRITE_GATE_BYTES
      if (entry.control) {
        // Holding gaps lets repeated background drops coalesce without filling the socket with markers.
        if (
          heldSessions.has(entry.sessionId) ||
          (socketDeep && entry.control.event === 'dataGap')
        ) {
          heldSessions.add(entry.sessionId)
          retained.push(entry)
          batch.queue.shift()
          continue
        }
        batch.queue.shift()
        releaseDaemonStreamEntry(batch, entry)
        this.write(clientId, entry.sessionId, socket, encodeNdjson(entry.control))
        continue
      }
      if (socketDeep && batch.queuedChars <= HELD_WRITE_THROUGH_TOTAL_CHARS) {
        const sessionHeld = batch.queuedCharsBySession.get(entry.sessionId) ?? 0
        if (
          heldSessions.has(entry.sessionId) ||
          batch.droppableQueuedSessionIds.has(entry.sessionId) ||
          sessionHeld > SMALL_SESSION_HOLD_BYPASS_CHARS
        ) {
          // Hold this flooding session's entry; small talkers keep flowing. No timer: a deep socket implies a prior false write(), so 'drain' (routed back to flush) is guaranteed to resume held bulk.
          heldSessions.add(entry.sessionId)
          retained.push(entry)
          batch.queue.shift()
          continue
        }
      } else if (socketDeep) {
        // Valve engaged: held bulk exceeded the memory cap, so echo protection is off until it drains — rare enough to log every time.
        recordDaemonStreamBacklogEvent('heldWriteThrough', {
          heldChars: batch.queuedChars,
          socketBufferedBytes: socket.writableLength ?? 0
        })
      }
      const end =
        entry.transformed || entry.data.length <= BULK_WRITE_SLICE_CHARS
          ? entry.data.length
          : clampToSafeSplitIndex(entry.data, 0, BULK_WRITE_SLICE_CHARS)
      const slice = entry.data.slice(0, end)
      const sliceEndSeq =
        entry.seq === undefined ? undefined : entry.seq - (entry.data.length - end)
      const entrySequenceChars = entry.sequenceChars ?? entry.data.length
      const sliceSequenceChars = entry.transformed
        ? entrySequenceChars
        : entrySequenceChars === 0
          ? 0
          : slice.length
      if (end >= entry.data.length) {
        batch.queue.shift()
        releaseDaemonStreamEntry(batch, entry)
      } else {
        entry.data = entry.data.slice(end)
        const remainingSequenceChars = entrySequenceChars - sliceSequenceChars
        entry.sequenceChars =
          remainingSequenceChars === entry.data.length ? undefined : remainingSequenceChars
      }
      batch.queuedChars -= slice.length
      const sessionHeldAfter =
        (batch.queuedCharsBySession.get(entry.sessionId) ?? slice.length) - slice.length
      if (sessionHeldAfter <= 0) {
        batch.queuedCharsBySession.delete(entry.sessionId)
        batch.droppableQueuedSessionIds.delete(entry.sessionId)
      } else {
        batch.queuedCharsBySession.set(entry.sessionId, sessionHeldAfter)
      }
      writeStreamDataEvents(
        { write: (line) => this.write(clientId, entry.sessionId, socket, line) },
        entry.sessionId,
        slice,
        this.maxLineBytes,
        sliceSequenceChars,
        sliceEndSeq,
        entry.transformed,
        entry.incarnationId
      )
    }
    this.updateBackpressure(clientId, batch)
    if (retained.length > 0) {
      batch.queue = retained
      // 'drain' only fires when the buffer fully empties (one gate-depth/turn = seconds for multi-MB backlogs); arm a no-op data event whose flush callback re-flushes while bytes are still in flight.
      if (!socket.destroyed) {
        const sessionId = retained[0].sessionId
        this.heldRefill.arm(clientId, sessionId, (line, complete) =>
          this.write(clientId, sessionId, socket, line, complete)
        )
      }
      return
    }
    this.pendingByClient.delete(clientId)
  }

  private write(
    clientId: string,
    sessionId: string,
    socket: Socket,
    line: string,
    onComplete?: () => void
  ): void {
    if (this.backpressure) {
      this.backpressure.write(clientId, sessionId, socket, line, onComplete)
    } else {
      socket.write(line, onComplete)
    }
  }

  private updateBackpressure(clientId: string, batch: PendingStreamDataBatch): void {
    this.backpressure?.setQueued(
      clientId,
      batch.queuedCharsBySession,
      batch.queuedMetadataBytesBySession
    )
  }

  private flushSession(clientId: string, sessionId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      this.clear(clientId)
      return
    }

    const socket = client.streamSocket
    flushDaemonStreamSession(batch, sessionId, this.maxLineBytes, (line) =>
      this.write(clientId, sessionId, socket, line)
    )
    if (batch.queue.length === 0) {
      this.pendingByClient.delete(clientId)
    }
    this.updateBackpressure(clientId, batch)
  }

  /** Reset socket-generation state without discarding queued payloads for a replacement stream. */
  replaceStream(clientId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (batch?.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    this.heldRefill.clear(clientId)
    this.backpressure?.clear(clientId)
  }

  clear(clientId?: string): void {
    const batches =
      clientId === undefined
        ? Array.from(this.pendingByClient.entries())
        : [[clientId, this.pendingByClient.get(clientId)] as const]

    for (const [id, batch] of batches) {
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
    }
    this.heldRefill.clear(clientId)
    this.backpressure?.clear(clientId)
  }
}
