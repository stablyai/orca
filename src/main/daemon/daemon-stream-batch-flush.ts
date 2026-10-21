import type { Socket } from 'node:net'
import type { DaemonStreamFraming } from './daemon-stream-binary-framing'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { DaemonStreamHeldRefill } from './daemon-stream-held-refill'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import { releaseDaemonStreamEntry } from './daemon-stream-entry-accounting'
import { prepareLeasedStreamWrite } from './daemon-stream-data-entry'
import { clampToSafeBulkWriteSplitIndex, streamFramesFor } from './daemon-stream-data-split'

// Shallow socket: the stream is one FIFO, so a deep buffer buries a visible pane's echo behind other panes' bulk; bulk stops here and is HELD (flushSession can jump it), bounding echo latency.
// 128KB stays above the socket's ~16KB highWaterMark so a held state implies a false write() and thus a guaranteed 'drain' wake-up.
export const SHALLOW_SOCKET_WRITE_GATE_BYTES =
  process.env.ORCA_DAEMON_SHALLOW_SOCKET_GATE === '0' ? Number.POSITIVE_INFINITY : 128 * 1024
// Sliced writes: a coalesced entry can grow to megabytes; writing it whole would re-deepen the socket past the gate in one call.
const BULK_WRITE_SLICE_CHARS = 64 * 1024
// Last resort for handles without pause support; actual memory bounds come from producer backpressure.
const HELD_WRITE_THROUGH_TOTAL_CHARS = 32 * 1024 * 1024
// Small-session bypass: a few-KB session (echo, redraws, query replies) is never the flood, so it must not wait FIFO behind others' megabytes; backstops the 100ms interactive fast-path, which misses under event-loop load.
const SMALL_SESSION_HOLD_BYPASS_CHARS = 4 * 1024

export function flushDaemonStreamBatch(
  clientId: string,
  batch: PendingStreamDataBatch,
  socket: Socket,
  framing: DaemonStreamFraming | undefined,
  maxLineBytes: number,
  heldRefill: DaemonStreamHeldRefill,
  write: (
    clientId: string,
    sessionId: string,
    socket: Socket,
    line: string | Buffer,
    onComplete?: () => void
  ) => void,
  updateBackpressure: () => void,
  removePending: () => void,
  onlySession?: string
): void {
  const frames = streamFramesFor(framing)
  // A session that held an entry must hold all its later entries this pass — writing around a held entry would reorder that session's bytes.
  const heldSessions = new Set<string>()
  let index = 0
  while (index < batch.queue.length) {
    const entry = batch.queue[index]
    if (onlySession !== undefined && entry.sessionId !== onlySession) {
      index++
      continue
    }
    const socketDeep = (socket.writableLength ?? 0) >= SHALLOW_SOCKET_WRITE_GATE_BYTES
    if (entry.observation) {
      if (heldSessions.has(entry.sessionId)) {
        index++
        continue
      }
      batch.queue.splice(index, 1)
      releaseDaemonStreamEntry(batch, entry)
      write(
        clientId,
        entry.sessionId,
        socket,
        entry.observation.startWrite(socket).buffer,
        entry.observation.release
      )
      continue
    }
    if (entry.control) {
      // Holding gaps lets repeated background drops coalesce without filling the socket with markers.
      if (heldSessions.has(entry.sessionId) || (socketDeep && entry.control.event === 'dataGap')) {
        heldSessions.add(entry.sessionId)
        index++
        continue
      }
      const prepared = entry.lease
        ? prepareLeasedStreamWrite(entry, framing ?? 'ndjson', maxLineBytes)
        : undefined
      if (prepared === null) {
        heldSessions.add(entry.sessionId)
        index++
        continue
      }
      batch.queue.splice(index, 1)
      releaseDaemonStreamEntry(batch, entry)
      entry.lease?.release()
      write(
        clientId,
        entry.sessionId,
        socket,
        prepared?.buffer ?? frames.control(entry.control),
        prepared?.lease.startWrite(socket).release
      )
      continue
    }
    if (
      onlySession === undefined &&
      socketDeep &&
      batch.queuedChars <= HELD_WRITE_THROUGH_TOTAL_CHARS
    ) {
      const sessionHeld = batch.queuedCharsBySession.get(entry.sessionId) ?? 0
      if (
        heldSessions.has(entry.sessionId) ||
        batch.droppableQueuedSessionIds.has(entry.sessionId) ||
        sessionHeld > SMALL_SESSION_HOLD_BYPASS_CHARS
      ) {
        // Hold this flooding session's entry; small talkers keep flowing. No timer: a deep socket implies a prior false write(), so 'drain' (routed back to flush) is guaranteed to resume held bulk.
        heldSessions.add(entry.sessionId)
        index++
        continue
      }
    } else if (socketDeep) {
      // Valve engaged: held bulk exceeded the memory cap, so echo protection is off until it drains — rare enough to log every time.
      recordDaemonStreamBacklogEvent('heldWriteThrough', {
        heldChars: batch.queuedChars,
        socketBufferedBytes: socket.writableLength ?? 0
      })
    }
    const prepared = entry.lease
      ? prepareLeasedStreamWrite(entry, framing ?? 'ndjson', maxLineBytes)
      : undefined
    if (prepared === null) {
      heldSessions.add(entry.sessionId)
      index++
      continue
    }
    const end =
      prepared?.end ??
      (entry.transformed || entry.data.length <= BULK_WRITE_SLICE_CHARS
        ? entry.data.length
        : clampToSafeBulkWriteSplitIndex(entry.data, BULK_WRITE_SLICE_CHARS))
    const slice = entry.data.slice(0, end)
    const entrySequenceChars = entry.sequenceChars ?? entry.data.length
    const sliceSequenceChars = entry.transformed
      ? entrySequenceChars
      : entrySequenceChars === 0
        ? 0
        : slice.length
    const finalSlice = end >= entry.data.length
    if (finalSlice) {
      batch.queue.splice(index, 1)
      releaseDaemonStreamEntry(batch, entry)
      if (prepared) {
        entry.lease?.release()
      }
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
    if (prepared) {
      write(
        clientId,
        entry.sessionId,
        socket,
        prepared.buffer,
        prepared.lease.startWrite(socket).release
      )
    } else {
      frames.data(
        { write: (line, done) => write(clientId, entry.sessionId, socket, line, done) },
        entry.sessionId,
        slice,
        maxLineBytes,
        sliceSequenceChars,
        entry.seq,
        entry.transformed,
        entry.lease?.startWrite(socket).release
      )
    }
  }
  updateBackpressure()
  if (batch.queue.length > 0) {
    // 'drain' only fires when the buffer fully empties (one gate-depth/turn = seconds for multi-MB backlogs); arm a no-op data event whose flush callback re-flushes while bytes are still in flight.
    if (heldSessions.size > 0 && !socket.destroyed) {
      const sessionId = heldSessions.values().next().value!
      heldRefill.arm(clientId, frames.noop(sessionId), (line, complete) =>
        write(clientId, sessionId, socket, line, complete)
      )
    }
    return
  }
  if (batch.timer) {
    clearTimeout(batch.timer)
  }
  removePending()
}
