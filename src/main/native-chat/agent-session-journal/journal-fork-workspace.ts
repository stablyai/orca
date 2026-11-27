import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { sourceThreadTurnMembership } from '../agent-session-wire/rewind/structured-rewind-cut'
import type Database from '../../sqlite/sync-database'

export function createJournalForkWorkspace(db: Database.Database): void {
  if (
    db
      .prepare('PRAGMA compile_options')
      .all()
      .some((row) => Object.values(row).includes('TEMP_STORE=3'))
  ) {
    throw new Error('fork preparation requires file-backed temporary storage')
  }
  db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048')
  if (Number(db.pragma('temp_store', { simple: true })) !== 1) {
    throw new Error('fork preparation temporary storage is not file-backed')
  }
  db.exec(`CREATE TEMP TABLE fork_headers(rank INTEGER PRIMARY KEY,item_id TEXT UNIQUE,provider_key TEXT,
      member TEXT,turn_item_id TEXT,turn_id TEXT,provider_turn_id TEXT,sequence INTEGER,sequence_index INTEGER,ordinal INTEGER,candidate INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX temp.fork_headers_member ON fork_headers(member,rank);
      CREATE TEMP TABLE fork_aliases(item_id TEXT PRIMARY KEY,provider_key TEXT NOT NULL);
      CREATE TEMP TABLE fork_kept(member TEXT PRIMARY KEY);
      CREATE TEMP TABLE fork_bodies(rank INTEGER PRIMARY KEY,item_id TEXT UNIQUE,mapped TEXT NOT NULL,notice TEXT,
        body_bytes INTEGER NOT NULL,lifecycle INTEGER NOT NULL,turn_scope_id TEXT,payload TEXT NOT NULL);
      CREATE TEMP TABLE fork_edges(parent TEXT NOT NULL,child TEXT NOT NULL,PRIMARY KEY(parent,child)) WITHOUT ROWID;
      CREATE TEMP TABLE fork_omitted(id TEXT UNIQUE,processed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX temp.fork_omitted_pending ON fork_omitted(processed);
      CREATE TEMP TABLE fork_work(anchor TEXT PRIMARY KEY,last_rank INTEGER NOT NULL);`)
}

/** UTF-8 bound strings and numeric scalars, without serializing rows containing source JSON. */
export function journalForkRowBytes(row: SqliteRow | string): number {
  return typeof row === 'string'
    ? Buffer.byteLength(row)
    : Object.values(row).reduce<number>(
        (bytes, value) =>
          bytes + (typeof value === 'string' ? Buffer.byteLength(value) : value === null ? 0 : 8),
        0
      )
}

export function journalForkHeaderMember(row: SqliteRow, sourceThreadId?: string): string | null {
  const identity = parseAgentJournalItemKey(String(row.provider_key))
  let member: string | null = null
  if (sourceThreadId) {
    const root =
      row.turn_item_id === null
        ? row
        : { provider_turn_id: row.root_provider_turn_id, turn_id: row.root_turn_id }
    member =
      sourceThreadTurnMembership(
        identity,
        sourceThreadId,
        root.provider_turn_id != null
          ? String(root.provider_turn_id)
          : root.turn_id != null
            ? String(root.turn_id)
            : undefined
      ) ?? null
  } else {
    member =
      row.turn_item_id !== null
        ? String(row.turn_item_id)
        : row.turn_id === null
          ? null
          : String(row.item_id)
  }
  return member
}
