import type { GapRecovery } from '../records/runtime-terminal-state-records'

// Only the capture-slot holders journal, so the fleet holds at most slots × this.
const GAP_JOURNAL_MAX_CHARS = 1024 * 1024
// Bounds observer catch-up per recovering PTY; older skipped output is dropped first.
const UNOBSERVED_MAX_CHARS = 32 * 1024
const UNOBSERVED_MAX_CHUNKS = 64

export function newGapRecovery(): GapRecovery {
  return {
    journal: null,
    journalStart: 0,
    journalEnd: 0,
    journalChars: 0,
    gaps: 0,
    unobserved: [],
    unobservedChars: 0
  }
}

/** Journal output after `seq`: a snapshot at or past it plus these bytes is the whole screen. */
export function startGapJournal(recovery: GapRecovery, seq: number): void {
  recovery.journal = []
  recovery.journalStart = seq
  recovery.journalEnd = seq
  recovery.journalChars = 0
}

export function stopGapJournal(recovery: GapRecovery): void {
  recovery.journal = null
  recovery.journalChars = 0
}

/** Another gap mid-capture: output before it is gone, so only a snapshot past it can rebuild. */
export function restartGapJournalAfterGap(recovery: GapRecovery, seq: number): void {
  recovery.gaps++
  if (recovery.journal) {
    startGapJournal(recovery, seq)
  }
}

export function journalGapRecoveryChunk(
  recovery: GapRecovery,
  data: string,
  seq: number,
  raw: boolean
): void {
  if (!recovery.journal) {
    return
  }
  const start = recovery.journalEnd
  recovery.journalEnd = seq
  recovery.journalChars += data.length
  if (recovery.journalChars > GAP_JOURNAL_MAX_CHARS) {
    // The attempt fails and retries; the live model keeps parsing meanwhile.
    stopGapJournal(recovery)
    return
  }
  recovery.journal.push({ start, end: seq, data, raw: raw && data.length === seq - start })
}

/** Output after `seq` through `parsedTo`; null when the journal cannot prove it (overflow, older snapshot, uncuttable chunk). */
export function gapJournalAfter(
  recovery: GapRecovery,
  seq: number,
  parsedTo: number
): string | null {
  if (!recovery.journal || seq < recovery.journalStart) {
    return null
  }
  let replay = ''
  for (const chunk of recovery.journal) {
    if (chunk.end > parsedTo) {
      break
    }
    if (chunk.end <= seq) {
      continue
    }
    if (chunk.start >= seq) {
      replay += chunk.data
      continue
    }
    if (!chunk.raw) {
      return null
    }
    replay += chunk.data.slice(seq - chunk.start)
  }
  return replay
}

/** Output the observers skipped on the untrusted screen, for them to read in order once it is rebuilt. */
export function noteUnobservedGapChunk(recovery: GapRecovery, chunk: string, at: number): void {
  const kept = chunk.length > UNOBSERVED_MAX_CHARS ? chunk.slice(-UNOBSERVED_MAX_CHARS) : chunk
  const last = recovery.unobserved.at(-1)
  if (last && recovery.unobserved.length >= UNOBSERVED_MAX_CHUNKS) {
    // Merged output keeps the earlier time: a notice must never look newer than it is.
    last.chunk += kept
  } else {
    recovery.unobserved.push({ chunk: kept, at })
  }
  recovery.unobservedChars += kept.length
  while (recovery.unobservedChars > UNOBSERVED_MAX_CHARS) {
    const oldest = recovery.unobserved[0]
    const excess = recovery.unobservedChars - UNOBSERVED_MAX_CHARS
    if (oldest.chunk.length > excess) {
      oldest.chunk = oldest.chunk.slice(excess)
      recovery.unobservedChars -= excess
    } else {
      recovery.unobserved.shift()
      recovery.unobservedChars -= oldest.chunk.length
    }
  }
}
