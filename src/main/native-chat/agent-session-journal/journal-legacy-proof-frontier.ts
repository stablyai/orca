import { journalSqlSourceContent } from './journal-sql-failure'
import { isJournalReaderReplyLimitFailure } from './journal-sql-reader-reply-limit'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import type { LegacyProofCursor, LegacyProofPage } from './journal-legacy-source-proof'
import {
  LEGACY_PROOF_COPIES_TABLE,
  type LegacyProofCounts
} from './journal-legacy-retirement-state'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlOwner } from './journal-sql-owner'

export type LegacyProofFrontier = {
  cursor: LegacyProofCursor | null
  page?: LegacyProofPage
  session: number
  pending: boolean
  /** Pages finished this run, for pacing progress saves. */
  pages: number
  /** What this run's pages held, for reporting only. */
  counts: LegacyProofCounts
  /** This run picked up saved progress instead of starting at the first page. */
  resumed: boolean
  /** `counts` cover every page from the first, across launches when progress carried them. */
  whole: boolean
  /** Began at the copies with nothing carried: its counts say nothing about the chats. */
  copiesOnly: boolean
  /** Chats unconverted when this page was first read: a retry reads them back as converted. */
  unconverted: Set<string>
}

export function createLegacyProofFrontier(
  cursor: LegacyProofCursor = { table: 0, after: null },
  carried?: { counts?: LegacyProofCounts }
): LegacyProofFrontier {
  const resumed = cursor.table !== 0 || cursor.after !== null
  return {
    cursor,
    session: 0,
    pending: false,
    pages: 0,
    counts: carried?.counts
      ? { ...carried.counts }
      : {
          chats: 0,
          alreadyConverted: 0,
          newlyConverted: 0,
          deletedHere: 0,
          drafts: 0,
          originals: 0,
          copies: 0
        },
    resumed,
    // Resumed in the copies, a quit partway through a page lost the copies it converted.
    whole: !resumed || (carried?.counts !== undefined && cursor.table < LEGACY_PROOF_COPIES_TABLE),
    copiesOnly: cursor.table >= LEGACY_PROOF_COPIES_TABLE && carried?.counts === undefined,
    unconverted: new Set()
  }
}

/** Progress is saved every this many pages, so a later launch repeats at most these. */
const LEGACY_PROOF_PROGRESS_PAGES = 16

export async function completeJournalLegacyProof(
  readers: Pick<JournalSqlReaderPool, 'legacyProof' | 'importState'>,
  conversions: Pick<JournalSqlConversions, 'ensure'>,
  writer: Pick<JournalSqlOwner, 'maintain'>,
  boundary: () => Promise<boolean>,
  signal: AbortSignal,
  rest: (started: number) => Promise<void>,
  frontier = createLegacyProofFrontier(),
  progress: (cursor: LegacyProofCursor) => Promise<void> = async () => {}
): Promise<void> {
  const admit = async () => {
    signal.throwIfAborted()
    if (!(await boundary())) {
      throw new Error('legacy proof was interrupted')
    }
    signal.throwIfAborted()
  }
  while (frontier.cursor) {
    await admit()
    if (!frontier.page) {
      const started = performance.now()
      frontier.page = await readers.legacyProof(frontier.cursor)
      for (const chat of frontier.page.sessions) {
        if (chat.convert && !chat.ready) {
          frontier.unconverted.add(chat.sessionId)
        }
      }
      await rest(started)
    }
    const page = frontier.page
    if (page.retained) {
      // A refusal is read again on the next attempt: what it waited on may have settled since.
      frontier.page = undefined
      throw new JournalLegacyRetentionError(page.retained, page.reason, page.artifact)
    }
    const originals = page.sessions.flatMap(({ sessionId, original }) =>
      original === undefined ? [] : [{ sessionId, ...original }]
    )
    const writing = performance.now()
    if (originals.length > 0) {
      await writer.maintain({ kind: 'legacy-originals-keep', originals })
    }
    if (page.claims?.length) {
      await writer.maintain({ kind: 'legacy-claims-absorb', claims: page.claims })
    }
    await rest(writing)
    // A copy converts from its original chat like any unconverted chat.
    const chats = page.copies
      ? page.copies.map((sessionId) => ({
          sessionId,
          workspaceId: '',
          epoch: '',
          empty: false,
          convert: true
        }))
      : page.sessions
    while (frontier.session < chats.length) {
      await admit()
      const source = chats[frontier.session]!
      // A chat deleted here, or one that never held anything, is not converted back.
      if (!source.convert) {
        frontier.session++
        continue
      }
      if (!frontier.pending) {
        frontier.pending = true
        try {
          await conversions.ensure(source.sessionId, false)
        } catch (error) {
          // The next attempt reads this page again from its start (a copies page shrinks as copies
          // convert), so a failure recorded since is seen, and converts the chat again.
          frontier.pending = false
          frontier.page = undefined
          frontier.session = 0
          const content = journalSqlSourceContent(error)
          if (content) {
            throw new JournalLegacyRetentionError(
              'legacy source has unreadable journal content',
              content === 'journalCorrupt' ? 'source-corrupt' : 'source-newer'
            )
          }
          // Rows too large for one reply fail the same way at every retry.
          if (isJournalReaderReplyLimitFailure(error)) {
            throw new JournalLegacyRetentionError(
              'an older Orca chat is too large to convert in one reply',
              'source-oversize'
            )
          }
          throw error
        }
      }
      // Read back from the store, not a cached epoch: the chat may have been deleted since. Each
      // request is paced like a page read; time spent waiting on a conversion is not.
      const started = performance.now()
      let state = await readers.importState(source.sessionId)
      if (state.state !== 'ready' && source.empty) {
        const epoch = await writer.maintain({
          kind: 'import-finish',
          header: {
            sessionId: source.sessionId,
            workspaceId: source.workspaceId,
            epoch: source.epoch,
            head: {
              lastSequence: 0,
              highestFence: 0,
              contextBoundary: 0,
              lastActivityAt: 0,
              derivedTurnItemId: null,
              historyOrigin: null,
              queueFailureBoundary: 0,
              queuePauseMarks: { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
            }
          }
        })
        if (typeof epoch !== 'string') {
          throw new Error('legacy proof received no committed empty-chat epoch')
        }
        state = { state: 'ready', epoch }
      }
      if (state.state !== 'ready') {
        throw new Error('legacy proof awaits committed conversion')
      }
      await rest(started)
      frontier.session++
      frontier.pending = false
      // Each copy as it converts: a copies page read again after a failure holds only the rest.
      if (page.copies) {
        frontier.counts.copies++
      }
    }
    // Other pages are counted once done, so a page read again after a failure isn't counted twice.
    if (!page.copies) {
      for (const chat of page.sessions) {
        const kind = !chat.convert
          ? chat.epoch === ''
            ? 'drafts'
            : 'deletedHere'
          : chat.ready && !frontier.unconverted.has(chat.sessionId)
            ? 'alreadyConverted'
            : 'newlyConverted'
        frontier.counts[kind] += 1
      }
      frontier.counts.chats += page.sessions.length
      frontier.counts.originals += originals.length
    }
    frontier.unconverted.clear()
    frontier.cursor = page.next
    frontier.page = undefined
    frontier.session = 0
    frontier.pages++
    // Before each copies page too: a converted copy leaves the original's mappings, so a quit must
    // resume in the copies, whose counts then read as partial, never from before them as whole.
    if (
      frontier.cursor &&
      (frontier.pages % LEGACY_PROOF_PROGRESS_PAGES === 0 ||
        frontier.cursor.table >= LEGACY_PROOF_COPIES_TABLE)
    ) {
      await progress(frontier.cursor)
    }
  }
  signal.throwIfAborted()
}
