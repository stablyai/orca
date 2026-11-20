import { journalSqlSourceContent } from './journal-sql-failure'
import { isJournalReaderReplyLimitFailure } from './journal-sql-reader-reply-limit'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import type { LegacyProofCursor, LegacyProofPage } from './journal-legacy-source-proof'
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
  /** The original carries a shape earlier builds refuse; its progress is saved under layout 2. */
  historical?: boolean
}

export function createLegacyProofFrontier(
  cursor: LegacyProofCursor = { table: 0, after: null }
): LegacyProofFrontier {
  return { cursor, session: 0, pending: false, pages: 0 }
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
      await rest(started)
    }
    const page = frontier.page
    if (page.historical) {
      frontier.historical = true
    }
    if (page.retained) {
      // A refusal is read again on the next attempt: what it waited on may have settled since.
      frontier.page = undefined
      throw new JournalLegacyRetentionError(page.retained, page.reason)
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
    }
    frontier.cursor = page.next
    frontier.page = undefined
    frontier.session = 0
    if (frontier.cursor && ++frontier.pages % LEGACY_PROOF_PROGRESS_PAGES === 0) {
      await progress(frontier.cursor)
    }
  }
  signal.throwIfAborted()
}
