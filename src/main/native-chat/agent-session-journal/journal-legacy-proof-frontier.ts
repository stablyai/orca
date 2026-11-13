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
  converted?: boolean
}

export function createLegacyProofFrontier(): LegacyProofFrontier {
  return { cursor: { table: 0, after: null }, session: 0, pending: false }
}

export async function completeJournalLegacyProof(
  readers: Pick<JournalSqlReaderPool, 'legacyProof' | 'importState'>,
  conversions: Pick<JournalSqlConversions, 'ensure'>,
  writer: Pick<JournalSqlOwner, 'maintain'>,
  boundary: () => Promise<boolean>,
  signal: AbortSignal,
  rest: (started: number) => Promise<void>,
  frontier = createLegacyProofFrontier()
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
    if (page.retained) {
      throw new JournalLegacyRetentionError(page.retained, page.reason)
    }
    while (frontier.session < page.sessions.length) {
      await admit()
      const source = page.sessions[frontier.session]!
      if (!frontier.pending) {
        frontier.pending = true
        await conversions.ensure(source.sessionId, false)
        frontier.converted = true
      }
      let state = await readers.importState(source.sessionId)
      if (state.state !== 'ready' && source.empty && frontier.converted) {
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
      frontier.session++
      frontier.pending = false
      frontier.converted = false
    }
    frontier.cursor = page.next
    frontier.page = undefined
    frontier.session = 0
  }
  signal.throwIfAborted()
}
