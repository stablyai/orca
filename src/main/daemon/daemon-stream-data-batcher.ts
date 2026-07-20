import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import {
  clampToSafeSplitIndex,
  encodeStreamDataEvent,
  writeStreamDataEvents
} from './daemon-stream-data-split'
import {
  backgroundSessionDropCapChars,
  backgroundSessionKeepTailChars,
  dropOldestQueuedForSession,
  type PendingStreamDataBatch
} from './daemon-stream-keep-tail-drop'
import type { DaemonEvent } from './types'
import { appendDaemonStreamData, type DaemonStreamEnqueueOptions } from './daemon-stream-data-entry'

type StreamDataClient = {
  streamSocket: Socket | null
}

// Why 2ms: under continuous agent output every chunk waits an expected
// half-window here AND again in main's PTY batch — at 8ms each that was
// ~8ms of the measured ~19ms DSR-under-load latency. 2ms keeps burst
// coalescing (~500 socket writes/s worst case, ~100B framing overhead per
// write against MB/s payloads) while cutting the fixed latency tax 4x.
const STREAM_DATA_BATCH_INTERVAL_MS = 2

// Why a shallow socket: the stream socket is one FIFO for every session, and
// bytes already written can never be overtaken — a deep user-space buffer
// buries a visible pane's keystroke echo behind bulk output for other panes
// (measured 192MB / 6+s under 12 flooding hidden agents). Bulk writes stop at
// this depth and the remainder is HELD here, where the interactive
// flushSession path can still jump it; socket 'drain' refills. Echo latency
// is then bounded by the shallow depth, not by how much bulk is in flight.
// 128KB must stay above the socket's ~16KB highWaterMark so a held state
// implies a false write() and therefore a guaranteed 'drain' wake-up.
// Kill switch: ORCA_DAEMON_SHALLOW_SOCKET_GATE=0 restores pre-gate unbounded
// socket writes for field debugging and true fix-off A/B benches.
const SHALLOW_SOCKET_WRITE_GATE_BYTES =
  process.env.ORCA_DAEMON_SHALLOW_SOCKET_GATE === '0' ? Number.POSITIVE_INFINITY : 128 * 1024
// Why sliced writes: enqueue coalesces per-session entries, so a held entry
// can grow to megabytes; writing it whole would re-deepen the socket past the
// gate in one call.
const BULK_WRITE_SLICE_CHARS = 64 * 1024
// Safety valve: if held bulk ever exceeds this, write through to the socket
// (exactly the pre-gate behavior) — bounded daemon memory beats bounded echo
// latency in the extreme. Must sit FAR above the pacer's pause watermark plus
// its overshoot (observed ~5MB with 17 paused sessions' in-flight pty reads):
// an engaged valve deepens the socket and buries interactive echo behind the
// whole backlog (measured as bimodal ~2.4s key medians when this was 8MB).
const HELD_WRITE_THROUGH_TOTAL_CHARS = 32 * 1024 * 1024
// Why a small-session bypass: the hold is there to stop FLOODS from burying
// everyone else; a session with only a few KB queued (keystroke echo, prompt
// redraws, query replies) is never the flood and must not wait FIFO behind
// other sessions' megabytes. The daemon's 100ms interactive fast-path is a
// heuristic that misses under event-loop load (measured: echo classified
// non-interactive rode the held queue for ~2.4s); this bypass is the
// deterministic backstop. Worst socket over-deepening per flush is
// sessions × this ≈ tens of KB.
const SMALL_SESSION_HOLD_BYPASS_CHARS = 4 * 1024

type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** Fires after each stream-socket write — the only place backlog grows, so
   *  the backlog pacer checks its watermark here. */
  onAfterSocketWrite?: () => void
  /** True for sessions whose queued output may be keep-tail dropped
   *  (main-marked background sessions). */
  isSessionDroppable?: (sessionId: string) => boolean
  /** Carve reply-eliciting query bytes (DSR/DA/DECRQM/OSC color probes) out
   *  of dropped data — the hidden program blocks on the reply, so those few
   *  bytes must still be delivered even when their flood is not. */
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
    appendDaemonStreamData(batch, sessionId, data, options)

    if (this.isSessionDroppable(sessionId)) {
      // Keep-tail scales down as more backgrounded sessions queue, bounding
      // the AGGREGATE a reveal must drain (see daemon-stream-keep-tail-drop).
      const droppableQueued = this.countDroppableSessionsWithQueuedData(batch)
      const dropCap = backgroundSessionDropCapChars(droppableQueued)
      const keepTail = backgroundSessionKeepTailChars(droppableQueued)
      if ((batch.queuedCharsBySession.get(sessionId) ?? 0) > dropCap) {
        dropOldestQueuedForSession(batch, sessionId, keepTail, this.salvageDroppedData)
      }
      if (droppableQueued > (batch.lastDroppableSessionCount ?? 0)) {
        // The shared budget tightened: re-trim sessions that already finished
        // producing — they never re-enter this path on their own.
        for (const [queuedSessionId, queued] of Array.from(batch.queuedCharsBySession)) {
          if (
            queued > dropCap &&
            queuedSessionId !== sessionId &&
            this.isSessionDroppable(queuedSessionId)
          ) {
            dropOldestQueuedForSession(batch, queuedSessionId, keepTail, this.salvageDroppedData)
          }
        }
      }
      batch.lastDroppableSessionCount = droppableQueued
    }

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

  /** Append a pre-shaped stream event at the current position in the
   *  session's byte order (scan handoff markers, gaps, transient facts). */
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

  private countDroppableSessionsWithQueuedData(batch: PendingStreamDataBatch): number {
    let count = 0
    for (const [sessionId, queued] of batch.queuedCharsBySession) {
      if (queued > 0 && this.isSessionDroppable(sessionId)) {
        count++
      }
    }
    return count
  }

  private getOrCreateBatch(clientId: string): PendingStreamDataBatch {
    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = { timer: null, queue: [], queuedChars: 0, queuedCharsBySession: new Map() }
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
      // Same as pre-gate behavior: a vanished stream socket drops the batch —
      // the model owns the bytes and reconnect restores from a snapshot.
      this.pendingByClient.delete(clientId)
      return
    }

    const socket = client.streamSocket
    // Sessions that held an entry must hold ALL their later entries in this
    // pass — writing around a held entry would reorder that session's bytes.
    const heldSessions = new Set<string>()
    const retained: PendingStreamDataBatch['queue'] = []
    while (batch.queue.length > 0) {
      const entry = batch.queue[0]
      if (entry.control) {
        // Control entries only respect the held-session order latch — they
        // are ~100B, so writing them onto a deep socket is as harmless as the
        // small-session bypass.
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
          // Hold this flooding session's entry; small talkers keep flowing.
          // The socket's 'drain' (routed back to flush by the server)
          // resumes held bulk. No timer: a deep socket implies a prior
          // false write(), so 'drain' is guaranteed.
          heldSessions.add(entry.sessionId)
          retained.push(entry)
          batch.queue.shift()
          continue
        }
      } else if (socketDeep) {
        // Valve engaged: held bulk exceeded the memory cap and is being
        // written through onto a deep socket — echo protection is off until
        // it drains. Rare enough to be worth a diagnostics event every time.
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
      // Held entries must not wait for the socket's 'drain' alone: drain only
      // fires when the user-space buffer fully EMPTIES, so bulk would advance
      // one gate-depth per daemon event-loop turn — seconds of dead time for
      // a multi-MB hidden backlog on a busy daemon (measured: hidden-restore
      // 2.5s vs the 1.5s budget). Arm ONE ~90B empty data event whose
      // kernel-flush callback re-flushes while bytes are still in flight, so
      // main never starves. (An empty socket write's callback fires
      // immediately — verified — so the sentinel must be a real protocol
      // no-op line.) Event-driven, no timers; the per-client latch stops
      // sentinel stacking; 'drain' remains the backstop.
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
