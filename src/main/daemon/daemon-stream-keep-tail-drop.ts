/**
 * Keep-tail thinning for backgrounded sessions' queued stream data. Hidden
 * panes' stream copy is a monitoring feed (tail previews, agent status) — the
 * daemon emulator holds the complete model and reveal restores from its
 * snapshot. Once a backgrounded session's undelivered output exceeds the cap,
 * its OLDEST bytes are dropped down to the keep-tail and a dataGap event
 * takes their place, so the feed stays tail-fresh, daemon memory stays
 * bounded, and the producer is never paused (no reveal catch-up).
 */
import { clampToSafeSplitIndex } from './daemon-stream-data-split'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { DaemonEvent, DataGapEvent } from './types'

// A control entry carries a whole pre-shaped stream event (background marker,
// data gap, transient fact) that must ride at its exact position in the
// session's byte order; its data is always '' so it never counts against the
// gate or drop caps, and drops never remove it.
export type StreamQueueEntry = {
  sessionId: string
  data: string
  streamGeneration?: number
  /** Original PTY characters represented by data. Salvaged query copies are
   * delivered bytes but represent zero new positions in the source stream. */
  sequenceChars?: number
  control?: DaemonEvent
}

export type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: StreamQueueEntry[]
  queuedChars: number
  // Per-session held totals so the flush hold can spare small talkers
  // (echo/replies) from waiting behind other sessions' floods.
  queuedCharsBySession: Map<string, number>
  // Last droppable-sessions-with-queued-data count seen by the keep-tail
  // logic: when it GROWS the shared budget tightens, and sessions that
  // finished producing must be re-trimmed (they will never re-enqueue).
  lastDroppableSessionCount?: number
}

// The keep-tail must comfortably cover a full TUI repaint (~cols×rows×SGR ≈
// 100KB) so the delivered tail always re-renders a coherent screen.
// Hysteresis (cap = 2× keep) bounds drop churn.
// Kill switch: ORCA_DAEMON_BACKGROUND_STREAM_DROP=0 disables thinning.
const BACKGROUND_SESSION_KEEP_TAIL_CHARS = 512 * 1024
const BACKGROUND_SESSION_MIN_KEEP_TAIL_CHARS = 64 * 1024
// Why a GLOBAL budget too: the per-session cap bounds each flood, but N
// backgrounded sessions can still queue N×cap in aggregate — and a reveal
// (worktree switch) then waits behind the whole aggregate at the gated drain
// rate (~8MB/s event-loop-turn-bound; measured 9MB queued → 2.5s hidden
// restore vs the 1.5s budget). Shrinking each session's keep-tail as more
// backgrounded sessions queue keeps the total ~2MB, so any reveal drains in
// ~250ms while every pane still keeps at least a full screen of tail.
const BACKGROUND_GLOBAL_KEEP_BUDGET_CHARS = 2 * 1024 * 1024

export function backgroundSessionKeepTailChars(droppableSessionsWithQueuedData: number): number {
  return Math.min(
    BACKGROUND_SESSION_KEEP_TAIL_CHARS,
    Math.max(
      BACKGROUND_SESSION_MIN_KEEP_TAIL_CHARS,
      Math.floor(BACKGROUND_GLOBAL_KEEP_BUDGET_CHARS / Math.max(1, droppableSessionsWithQueuedData))
    )
  )
}

export function backgroundSessionDropCapChars(droppableSessionsWithQueuedData: number): number {
  return backgroundSessionKeepTailChars(droppableSessionsWithQueuedData) * 2
}
// Mirrors main's DROPPED_QUERY_SALVAGE_MAX_CHARS: salvage past this means a
// pathological query stream; keep the O(1) memory guarantee. A prior drop's
// salvage entry is itself the oldest data and re-salvages through the next
// drop, so query order is preserved across repeated drops.
const DROPPED_QUERY_SALVAGE_MAX_CHARS = 4096

/** Trim the session's OLDEST queued data down to the keep-tail and leave (or
 *  grow) a dataGap control entry where the dropped bytes were. Control
 *  entries are never dropped. Boundary note: the kept tail can start
 *  mid-escape-sequence — deliberate; the receiver treats a gap as a
 *  tail-preview reset and transient-fact scanning is daemon-authoritative
 *  for droppable sessions, so nothing downstream parses across the cut. */
export function dropOldestQueuedForSession(
  batch: PendingStreamDataBatch,
  sessionId: string,
  keepTailChars: number,
  salvageDroppedData: (dropped: string) => string
): void {
  let remainingToDrop = (batch.queuedCharsBySession.get(sessionId) ?? 0) - keepTailChars
  if (remainingToDrop <= 0) {
    return
  }
  const generatedSalvageEntries = new Set<StreamQueueEntry>()
  let totalDropped = 0

  while (remainingToDrop > 0) {
    let generation: number | undefined
    let foundGeneration = false
    let dropped = 0
    let droppedSequenceChars = 0
    let salvaged = ''
    let existingGap: DataGapEvent | null = null
    let insertGapAt = -1

    const salvageIntoCap = (value: string): void => {
      if (salvaged.length >= DROPPED_QUERY_SALVAGE_MAX_CHARS) {
        return
      }
      salvaged = (salvaged + salvageDroppedData(value)).slice(0, DROPPED_QUERY_SALVAGE_MAX_CHARS)
    }

    for (let i = 0; i < batch.queue.length && dropped < remainingToDrop; i++) {
      const entry = batch.queue[i]
      if (entry.sessionId !== sessionId || generatedSalvageEntries.has(entry)) {
        continue
      }
      if (entry.control) {
        if (
          entry.control.event === 'dataGap' &&
          (!foundGeneration || entry.streamGeneration === generation)
        ) {
          existingGap = entry.control
        }
        continue
      }
      if (!foundGeneration) {
        generation = entry.streamGeneration
        foundGeneration = true
        if (existingGap?.streamGeneration !== generation) {
          existingGap = null
        }
      } else if (entry.streamGeneration !== generation) {
        // Why: one gap/salvage pair must never claim bytes from two stream
        // owners. The outer loop handles the next generation independently.
        break
      }

      const available = remainingToDrop - dropped
      if (entry.data.length <= available) {
        dropped += entry.data.length
        droppedSequenceChars += entry.sequenceChars ?? entry.data.length
        salvageIntoCap(entry.data)
        if (insertGapAt === -1) {
          insertGapAt = i
        }
        batch.queue.splice(i, 1)
        i--
        continue
      }

      const cut = clampToSafeSplitIndex(entry.data, 0, available)
      if (cut > 0) {
        const entrySequenceChars = entry.sequenceChars ?? entry.data.length
        const cutSequenceChars = entrySequenceChars === 0 ? 0 : cut
        dropped += cut
        droppedSequenceChars += cutSequenceChars
        salvageIntoCap(entry.data.slice(0, cut))
        entry.data = entry.data.slice(cut)
        const remainingSequenceChars = entrySequenceChars - cutSequenceChars
        entry.sequenceChars =
          remainingSequenceChars === entry.data.length ? undefined : remainingSequenceChars
        if (insertGapAt === -1) {
          insertGapAt = i
        }
      }
      break
    }

    if (!foundGeneration || dropped <= 0) {
      break
    }

    totalDropped += dropped
    remainingToDrop -= dropped
    batch.queuedChars -= dropped
    batch.queuedCharsBySession.set(
      sessionId,
      Math.max(0, (batch.queuedCharsBySession.get(sessionId) ?? 0) - dropped)
    )

    if (existingGap) {
      const priorSequenceChars =
        existingGap.payload.sequenceChars ?? existingGap.payload.droppedChars
      existingGap.payload.droppedChars += dropped
      existingGap.payload.sequenceChars = priorSequenceChars + droppedSequenceChars
    } else {
      const gap: DataGapEvent = {
        type: 'event',
        event: 'dataGap',
        sessionId,
        ...(generation === undefined ? {} : { streamGeneration: generation }),
        payload: { droppedChars: dropped, sequenceChars: droppedSequenceChars }
      }
      batch.queue.splice(Math.max(0, insertGapAt), 0, {
        sessionId,
        data: '',
        streamGeneration: generation,
        control: gap
      })
      existingGap = gap
    }

    if (salvaged.length > 0) {
      // Salvaged query bytes ride as a tiny data entry at the gap position —
      // the writing program is blocked on their replies. Keep the originating
      // token so a later attach cannot mistake them for the replacement stream.
      const salvageEntry: StreamQueueEntry = {
        sessionId,
        data: salvaged,
        streamGeneration: generation,
        sequenceChars: 0
      }
      const at = batch.queue.findIndex((entry) => entry.control === existingGap) + 1
      batch.queue.splice(at, 0, salvageEntry)
      generatedSalvageEntries.add(salvageEntry)
      batch.queuedChars += salvaged.length
      batch.queuedCharsBySession.set(
        sessionId,
        (batch.queuedCharsBySession.get(sessionId) ?? 0) + salvaged.length
      )
    }
  }

  if (totalDropped > 0) {
    recordDaemonStreamBacklogEvent('backgroundKeepTailDrop', {
      sessionIdSuffix: sessionId.slice(-10),
      droppedChars: totalDropped
    })
  }
}
