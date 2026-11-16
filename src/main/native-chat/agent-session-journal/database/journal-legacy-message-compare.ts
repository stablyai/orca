import type Database from '../../../sqlite/sync-database'
import {
  restoreJournalDomainImport,
  type JournalDomainImportPage,
  type RestoredJournalDomainImport
} from '../journal-domain-import'
import { readJournalStoredRow } from '../journal-stored-output-rows'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { OlderMessageCursor } from './journal-legacy-older-messages'

/** CI lines and other status rows, turn edges and the rows an open rewrites on its own aren't. */
export function isRealMessage(item: unknown): boolean {
  if (!isObject(item) || item.recovered === true || !isObject(item.body)) {
    return false
  }
  switch (item.body.kind) {
    case 'message':
      return item.body.role !== 'system'
    case 'tool-call':
    case 'diff':
    case 'approval':
    case 'question':
      return true
    default:
      return false
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text))
  } catch {
    return undefined
  }
}

/**
 * Held only as the same item here, at the same revision (or a later one) with the same body. A
 * removal here proves nothing: the two files count revisions on their own, so its text may differ.
 */
export function heldItem(
  db: Database.Database,
  id: string,
  epoch: string,
  item: HeldShape,
  revision: 'same' | 'or-later' = 'same'
): boolean {
  // The revision is checked first, so a payload is read only when it can match.
  const row = db
    .prepare(
      `SELECT payload_json, output_blob FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?
        AND revision ${revision === 'same' ? '=' : '>='} ?`
    )
    .get(id, epoch, item.itemId, item.revision)
  if (!row) {
    return false
  }
  // Compared as written, with a tool output stored apart read back in.
  return sameBody(readJournalStoredRow(db, [id, epoch], row).body, item.body)
}

export type HeldShape = { itemId: string; revision: number; body: unknown }

export function isHeldShape(item: unknown): item is HeldShape {
  return isObject(item) && typeof item.itemId === 'string' && typeof item.revision === 'number'
}

export function sameBody(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** This chat holds the text as a queued card, or as the send that card was set back from. */
export function heldTextHere(
  db: Database.Database,
  id: string,
  epoch: string,
  messageId: string,
  body: unknown
): boolean {
  for (const row of db
    .prepare(`SELECT payload_json AS payload FROM journal_queue_cards
        WHERE session_id=?1 AND epoch=?2 AND message_id=?3
      UNION ALL SELECT payload_json FROM journal_items
        WHERE session_id=?1 AND epoch=?2 AND item_id=?4`)
    .all(id, epoch, messageId, agentJournalSubmissionKey(messageId))) {
    const payload = parseJson(row.payload)
    if (isObject(payload) && sameBody(payload.body, body)) {
      return true
    }
  }
  return false
}

/**
 * Without a revision, the chat's whole restored history is compared: with what a converted chat
 * holds here, or with when the original was last read.
 */
export function addedBesideHeld(
  db: Database.Database,
  id: string,
  cursor: Exclude<OlderMessageCursor, { kind: 'revision' }>,
  restore: () => RestoredJournalDomainImport | null
): boolean {
  const imported = restore()
  if (!imported) {
    return false
  }
  const held = (table: string, key: string): boolean =>
    cursor.kind === 'held' &&
    db
      .prepare(`SELECT 1 FROM ${table} WHERE session_id=? AND epoch=? AND message_id=? LIMIT 1`)
      .get(id, cursor.epoch, key) !== undefined
  for (const page of imported.pages()) {
    if (page.kind === 'items') {
      for (const { item } of page.rows) {
        if (
          isRealMessage(item) &&
          (cursor.kind === 'held'
            ? !heldItem(db, id, cursor.epoch, item)
            : item.observedAt > cursor.after)
        ) {
          return true
        }
      }
    } else if (page.kind === 'attempts' && cursor.kind === 'held') {
      if (
        page.rows.some(
          ({ submission }) => !held('journal_submission_attempts', submission.clientMessageId)
        )
      ) {
        return true
      }
    } else if (page.kind === 'cards') {
      if (
        page.rows.some(
          (card) =>
            (card.state === 'waiting' || card.state === 'returned') &&
            // Cards carry no time: under a time cursor queued text is kept, never taken as shown.
            (cursor.kind === 'time' ||
              !heldTextHere(db, id, cursor.epoch, card.messageId, card.body))
        )
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * A chat's history restored at most once, for comparing with what is held here and then copying.
 * Without a revision the comparison reads its pages first, so the copy reuses what it built.
 */
export function chatHistoryRestore(
  source: Database.Database,
  id: string,
  cursor: OlderMessageCursor | null
): () => RestoredJournalDomainImport | null {
  let restored: RestoredJournalDomainImport | null | undefined
  return () => {
    if (restored !== undefined) {
      return restored
    }
    const imported = restoreJournalDomainImport(source, id)
    restored = cursor === null || cursor.kind === 'revision' ? imported : readTwice(imported)
    return restored
  }
}

/**
 * For a comparison a copy may follow: the copy replays the pages the comparison built, letting each
 * go, then builds on from where it stopped, so no page is built twice.
 */
function readTwice(
  imported: RestoredJournalDomainImport | null
): RestoredJournalDomainImport | null {
  if (!imported) {
    return null
  }
  const built: (JournalDomainImportPage | undefined)[] = []
  let source: Generator<JournalDomainImportPage> | undefined
  let reads = 0
  return {
    ...imported,
    *pages() {
      const first = reads++ === 0
      source ??= imported.pages()
      if (!first) {
        for (let index = 0; index < built.length; index += 1) {
          const page = built[index]!
          built[index] = undefined
          yield page
        }
        built.length = 0
      }
      for (let next = source.next(); !next.done; next = source.next()) {
        if (first) {
          built.push(next.value)
        }
        yield next.value
      }
    }
  }
}
