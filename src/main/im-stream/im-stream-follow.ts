// A chat's journal as an IM stream reads it: again after each publication, one read at a time and
// at most one per gap, so a streamed token never costs a read of its own.
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import { imStreamTimer, type ImStreamTimer } from './im-stream-throttle'

export type ImJournalReads = Pick<JournalSqlReads, 'operationWindow' | 'canonicalItemId' | 'item'>

/** The structured agent session host, as much of it as an IM stream reads. */
export type ImJournal = {
  observeJournalPublications(sessionId: string, observer: () => void): () => void
  journalReads(sessionId: string): Promise<ImJournalReads>
}

export const IM_JOURNAL_READ_GAP_MS = 500

export type ImJournalFollowOptions = {
  gapMs?: number
  now?: () => number
  timer?: ImStreamTimer
}

/** Calls `read` at once and again after each publication: never two at once, starts at least
 *  `gapMs` apart, and one more after a read that publications came during. A read that throws waits
 *  for the next publication; one that returns 'stop' ends the follow. `active` turns false once
 *  released, for a read to check after its awaits. Returns the release. */
export function followImJournal(
  journal: ImJournal,
  sessionId: string,
  read: (reads: ImJournalReads, active: () => boolean) => Promise<'stop' | void>,
  options: ImJournalFollowOptions = {}
): () => void {
  const gapMs = options.gapMs ?? IM_JOURNAL_READ_GAP_MS
  const now = options.now ?? Date.now
  const timer = options.timer ?? imStreamTimer
  let released = false
  let reading = false
  let again = false
  let cancel: (() => void) | null = null
  let unobserve: (() => void) | null = null
  let lastStart = Number.NEGATIVE_INFINITY

  const release = (): void => {
    released = true
    unobserve?.()
    unobserve = null
    cancel?.()
    cancel = null
  }
  const run = async (): Promise<void> => {
    reading = true
    again = false
    lastStart = now()
    try {
      const reads = await journal.journalReads(sessionId)
      if (!released && (await read(reads, () => !released)) === 'stop') {
        release()
      }
    } catch {
      // A chat closing or a read racing its writer: progress is best effort, the next one reads.
    } finally {
      reading = false
      if (again) {
        schedule()
      }
    }
  }
  const schedule = (): void => {
    if (released || cancel) {
      return
    }
    if (reading) {
      again = true
      return
    }
    cancel = timer(
      () => {
        cancel = null
        void run()
      },
      Math.max(0, lastStart + gapMs - now())
    )
  }
  unobserve = journal.observeJournalPublications(sessionId, schedule)
  schedule()
  return release
}
