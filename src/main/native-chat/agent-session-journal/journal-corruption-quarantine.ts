// Corruption never deletes history. A journal that cannot be read end to end
// keeps its intact prefix live and moves the unreadable remainder aside, so the
// bytes stay on disk for inspection instead of being rebuilt into an empty epoch.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  JOURNAL_SNAPSHOT_FILE,
  quarantineJournalRemainder,
  readJournalLog,
  rewriteJournalLog
} from './journal-log-file'
import type { JournalRow } from './journal-row-schema'

/** Keep the readable prefix and set the unreadable suffix aside. */
export async function quarantineCorruptSuffix(
  journalDir: string,
  retainedRows: readonly JournalRow[],
  remainder: string | undefined
): Promise<void> {
  if (remainder) {
    await quarantineJournalRemainder(journalDir, remainder)
  }
  await rewriteJournalLog(journalDir, retainedRows)
}

/** Copy everything aside before a read-only journal is rebuilt under a newer
 *  schema: those rows are unreadable to THIS build, not worthless. The
 *  snapshot is preserved as raw bytes — a future-version snapshot does not
 *  parse under this build's schema, and its bytes must survive verbatim. */
export async function quarantineUnreadableSchema(journalDir: string): Promise<void> {
  const snapshot = await readSnapshotBytes(journalDir)
  const log = await readJournalLog(journalDir)
  const preserved = [
    snapshot ?? '',
    log.rows.map((row) => JSON.stringify(row)).join('\n'),
    log.remainder ?? ''
  ]
    .filter(Boolean)
    .join('\n')
  if (preserved) {
    await quarantineJournalRemainder(journalDir, preserved)
  }
}

async function readSnapshotBytes(journalDir: string): Promise<string | null> {
  try {
    return await readFile(join(journalDir, JOURNAL_SNAPSHOT_FILE), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/** The disclosure row for lines that failed to parse. Skipped lines are lost
 *  rows; counting them silently is the drop this exists to prevent. */
export function malformedRowsDisclosure(count: number): {
  identity: { provider: 'orca'; clientMessageId: string }
  body: { kind: 'status'; text: string }
} {
  const plural = count === 1 ? '' : 's'
  return {
    // One stable identity, so a reopen upserts the same row instead of adding one.
    identity: { provider: 'orca', clientMessageId: 'journal-malformed-lines' },
    body: {
      kind: 'status',
      text: `${count} journal line${plural} could not be read and ${count === 1 ? 'was' : 'were'} skipped`
    }
  }
}
