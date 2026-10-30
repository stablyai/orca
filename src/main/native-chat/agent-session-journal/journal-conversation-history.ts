import { z } from 'zod'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type Database from '../../sqlite/sync-database'

const scope = z.strictObject({ aliases: z.array(z.string()), root: z.string().nullable() })
const bookkeeping = z.strictObject({
  kind: z.literal('tombstone'),
  itemId: z.literal(agentJournalItemKey({ provider: 'orca', clientMessageId: 'mail-boundary' })),
  revision: z.literal(1),
  seq: z.literal(2),
  epoch: z.string().min(1),
  v: z.int().positive(),
  fence: z.int().nonnegative(),
  ts: z.number(),
  mailBoundary: z.union([
    z.strictObject({ status: z.literal('released'), scope: scope.optional() }),
    z.strictObject({
      status: z.literal('held'),
      stop: z.null(),
      cuts: z.tuple([]),
      members: z.tuple([]),
      ambiguous: z.literal(true),
      scope: scope.optional()
    })
  ])
})

/** Only the exact obsolete Q baseline is non-conversation; it confers no fresh/human authority. */
export function journalHasConversationHistory(
  db: Database.Database,
  sessionId: string,
  epoch: string
): boolean {
  for (const stored of db
    .prepare(`SELECT row_json FROM journal_rows
    WHERE session_id = ? AND epoch = ? AND seq > 1 ORDER BY seq`)
    .iterate(sessionId, epoch)) {
    try {
      if (!bookkeeping.safeParse(JSON.parse(String(stored.row_json))).success) {
        return true
      }
    } catch {
      return true
    }
  }
  return false
}
