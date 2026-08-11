import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import {
  clampToSafeSplitIndex,
  encodeStreamDataEvent,
  writeStreamDataEvents
} from './daemon-stream-data-split'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { DaemonEvent } from './types'
import { appendDaemonStreamData, type DaemonStreamEnqueueOptions } from './daemon-stream-data-entry'
import {
  evaluateDroppableEnqueue,
  refreshDroppableSessionMembership
} from './daemon-stream-droppable-membership'

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
// Safety valve: past this, write through — bounded daemon memory beats bounded echo latency in the extreme. Must sit FAR above the pacer's pause watermark + overshoot (~5MB) or an engaged valve buries interactive echo behind the whole backlog.
const HELD_WRITE_THROUGH_TOTAL_CHARS = 32 * 1024 * 1024
// Small-session bypass: a few-KB session (echo, redraws, query replies) is never the flood, so it must not wait FIFO behind others' megabytes; backstops the 100ms interactive fast-path, which misses under event-loop load.
const SMALL_SESSION_HOLD_BYPASS_CHARS = 4 * 1024

type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** Fires after each stream-socket write — the only place backlog grows, so the backlog pacer checks its watermark here. */
  onAfterSocketWrite?: () => void
  /** True for sessions whose queued output may be keep-tail dropped (main-marked background sessions). */
  isSessionDroppable?: (sessionId: string) => boolean
  /** Carve reply-eliciting query bytes (DSR/DA/DECRQM/OSC probes) out of dropped data — the hidden program blocks on the reply, so they must still be delivered even when their flood is not. */
  salvageDroppedData?: (dropped: string) => string
}

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number
  private onAfterSocketWrite: (() => void) | undefined
  private isSessionDroppable: (sessionId: string) => boolean
  private salvageDroppedData: (dropped: string) => string

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    this.onAfterSocketWrite = options.onAfterSocketWrite
    this.isSessionDroppable = options.isSessionDroppable ?? (() => false)
    this.salvageDroppedData = options.salvageDroppedData ?? (() => '')
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

    if (
      options.flushImmediately === true &&
      this.queuedCharsForSession(batch, sessionId) <=
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
    batch.queue.push({ sessionId, data: '', control })
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  refreshSessionDroppability(sessionId: string): void {
    const droppable = this.isSessionDroppable(sessionId)
    refreshDroppableSessionMembership(this.pendingByClient.values(), sessionId, droppable)
  }

  private getOrCreateBatch(clientId: string): PendingStreamDataBatch {
    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = {
        timer: null,
        queue: [],
        queuedChars: 0,
        queuedCharsBySession: new Map(),
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
      this.pendingByClient.delete(clientId)
      return
    }

    const socket = client.streamSocket
    // A session that held an entry must hold all its later entries this pass — writing around a held entry would reorder that session's bytes.
    const heldSessions = new Set<string>()
    const retained: PendingStreamDataBatch['queue'] = []
    while (batch.queue.length > 0) {
      const entry = batch.queue[0]
      if (entry.control) {
        // Control entries only respect the held-session order latch; at ~100B, writing them onto a deep socket is as harmless as the small-session bypass.
        if (heldSessions.has(entry.sessionId)) {
          retained.push(entry)
          batch.queue.shift()
          continue
        }
        batch.queue.shift()
        socket.write(encodeNdjson(entry.control))
        this.onAfterSocketWrite?.()
        continue
      }
      const socketDeep = (socket.writableLength ?? 0) >= SHALLOW_SOCKET_WRITE_GATE_BYTES
      if (socketDeep && batch.queuedChars <= HELD_WRITE_THROUGH_TOTAL_CHARS) {
        const sessionHeld = batch.queuedCharsBySession.get(entry.sessionId) ?? 0
        if (heldSessions.has(entry.sessionId) || sessionHeld > SMALL_SESSION_HOLD_BYPASS_CHARS) {
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
      const entrySequenceChars = entry.sequenceChars ?? entry.data.length
      const sliceSequenceChars = entry.transformed
        ? entrySequenceChars
        : entrySequenceChars === 0
          ? 0
          : slice.length
      if (end >= entry.data.length) {
        batch.queue.shift()
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
        socket,
        entry.sessionId,
        slice,
        this.maxLineBytes,
        sliceSequenceChars,
        entry.seq,
        entry.transformed
      )
      this.onAfterSocketWrite?.()
    }
    if (retained.length > 0) {
      batch.queue = retained
      // 'drain' only fires when the buffer fully empties (one gate-depth/turn = seconds for multi-MB backlogs); arm a no-op data event whose flush callback re-flushes while bytes are still in flight.
      this.armHeldQueueRefill(socket, clientId, retained[0].sessionId)
      return
    }
    this.pendingByClient.delete(clientId)
  }

  private refillArmedClients = new Set<string>()

  private armHeldQueueRefill(socket: Socket, clientId: string, sessionId: string): void {
    if (this.refillArmedClients.has(clientId) || socket.destroyed) {
      return
    }
    this.refillArmedClients.add(clientId)
    // Must be a real protocol no-op line, not an empty write: an empty write's callback fires immediately, defeating the in-flight re-flush.
    socket.write(encodeStreamDataEvent(sessionId, ''), () => {
      this.refillArmedClients.delete(clientId)
      this.flush(clientId)
    })
  }

  private queuedCharsForSession(batch: PendingStreamDataBatch, sessionId: string): number {
    let chars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        chars += entry.data.length
      }
    }
    return chars
  }

  private flushSession(clientId: string, sessionId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    const flushed: PendingStreamDataBatch['queue'] = []
    const retained: PendingStreamDataBatch['queue'] = []
    let flushedChars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        flushed.push(entry)
        flushedChars += entry.data.length
      } else {
        retained.push(entry)
      }
    }
    if (flushed.length === 0) {
      return
    }

    batch.queue = retained
    batch.queuedChars -= flushedChars
    batch.queuedCharsBySession.delete(sessionId)
    batch.droppableQueuedSessionIds.delete(sessionId)
    if (batch.queue.length === 0) {
      if (batch.timer) {
        clearTimeout(batch.timer)
        batch.timer = null
      }
      this.pendingByClient.delete(clientId)
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    for (const entry of flushed) {
      if (entry.control) {
        client.streamSocket.write(encodeNdjson(entry.control))
        this.onAfterSocketWrite?.()
      } else {
        writeStreamDataEvents(
          client.streamSocket,
          entry.sessionId,
          entry.data,
          this.maxLineBytes,
          entry.sequenceChars ?? entry.data.length,
          entry.seq,
          entry.transformed
        )
        this.onAfterSocketWrite?.()
      }
    }
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
  }
}
