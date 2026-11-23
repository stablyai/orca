import type {
  GapRecovery,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'

// Only the capture-slot holders journal, so the fleet holds at most slots × this.
const GAP_JOURNAL_MAX_CHARS = 1024 * 1024
// Charged per record too, so tiny chunks cannot pile up records the text budget never sees.
const GAP_JOURNAL_RECORD_CHARS = 32

export function newGapRecovery(): GapRecovery {
  return {
    journal: null,
    journalStart: 0,
    journalEnd: 0,
    journalChars: 0,
    gaps: 0,
    providerOwnedBeforeGap: false
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
  // Empty frames that advance nothing (stream refills) have nothing to replay.
  if (!recovery.journal || (data === '' && seq === recovery.journalEnd)) {
    return
  }
  const start = recovery.journalEnd
  recovery.journalEnd = seq
  recovery.journalChars += data.length + GAP_JOURNAL_RECORD_CHARS
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

export function isScreenRestoring(state: RuntimeHeadlessTerminal | undefined): boolean {
  return state?.gapReseed !== undefined || state?.awaitingContextSeed === true
}
