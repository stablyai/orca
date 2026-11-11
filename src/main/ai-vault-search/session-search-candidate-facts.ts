import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { sessionSearchFileFacts, sessionSearchFileValues } from './session-search-file-facts'
import { initializeSessionSearchStorage } from './session-search-storage-bootstrap'

export type SessionSearchFactReference = { id: number; revision: number }
const stores = new WeakMap<SyncDatabase, SessionSearchCandidateFacts>()
export function sessionSearchCandidateFacts(db: SyncDatabase): SessionSearchCandidateFacts {
  let store = stores.get(db)
  if (!store) {
    store = new SessionSearchCandidateFacts(db)
    stores.set(db, store)
  }
  return store
}

export function sessionSearchStoredCandidate(row: Record<string, unknown>): SessionFileCandidate {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the typed candidate input is the only writer of this agent field.
    agent: String(row.agent) as SessionFileCandidate['agent'],
    file: {
      ...sessionSearchFileFacts(row, String(row.path)),
      modifiedAt: new Date(Number(row.mtime)).toISOString()
    },
    codexHome: row.codex_home == null ? null : String(row.codex_home),
    ...(row.history_path == null ? {} : { antigravityHistoryPath: String(row.history_path) })
  }
}

export class SessionSearchCandidateFacts {
  private revision = 0
  constructor(private readonly db: SyncDatabase) {
    initializeSessionSearchStorage(db)
    db.exec(`CREATE TEMP TABLE search_candidate_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_revision INTEGER NOT NULL,
      agent TEXT NOT NULL, path TEXT NOT NULL, mtime REAL NOT NULL, size REAL,
      dev REAL, ino REAL, nlink REAL, alias_mtime REAL, sidecar TEXT,
      codex_home TEXT, history_path TEXT
    );
    CREATE TEMP TABLE search_read_work (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
      fact_id INTEGER NOT NULL, fact_revision INTEGER NOT NULL,
      version INTEGER NOT NULL, force_read INTEGER NOT NULL, metadata INTEGER NOT NULL,
      lane TEXT NOT NULL, rank REAL NOT NULL, ordering INTEGER NOT NULL,
      due INTEGER NOT NULL, deferred INTEGER NOT NULL
    );
    CREATE INDEX temp.search_read_work_lane ON search_read_work(lane,rank,ordering,path);
    CREATE INDEX temp.search_read_work_fact ON search_read_work(fact_id,fact_revision);`)
  }
  get(reference: SessionSearchFactReference): SessionFileCandidate {
    const row = this.db
      .prepare(
        'SELECT agent,path,mtime,size,dev,ino,nlink,alias_mtime,sidecar,codex_home,history_path FROM temp.search_candidate_facts WHERE id=? AND snapshot_revision=?'
      )
      .get(reference.id, reference.revision)
    if (!row) {
      throw new Error('Session work candidate snapshot is unavailable')
    }
    return sessionSearchStoredCandidate(row)
  }
  acquire(
    candidate: SessionFileCandidate,
    references: SessionSearchFactReference[] = [],
    known?: { reference: SessionSearchFactReference; candidate: SessionFileCandidate }
  ): SessionSearchFactReference {
    const key = (value: SessionFileCandidate) =>
      JSON.stringify([
        value.agent,
        value.file.path,
        ...sessionSearchFileValues(value.file),
        value.codexHome,
        value.antigravityHistoryPath ?? null
      ])
    const expected = key(candidate)
    for (const reference of references) {
      const loaded =
        known &&
        known.reference.id === reference.id &&
        known.reference.revision === reference.revision
          ? known.candidate
          : this.get(reference)
      if (key(loaded) === expected) {
        return reference
      }
    }
    const revision = ++this.revision
    const result = this.db
      .prepare(`INSERT INTO temp.search_candidate_facts
      (snapshot_revision,agent,path,mtime,size,dev,ino,nlink,alias_mtime,sidecar,codex_home,history_path)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        revision,
        candidate.agent,
        candidate.file.path,
        ...sessionSearchFileValues(candidate.file),
        candidate.codexHome,
        candidate.antigravityHistoryPath ?? null
      )
    return { id: Number(result.lastInsertRowid), revision }
  }
  reclaim(reference: SessionSearchFactReference | undefined): void {
    if (!reference) {
      return
    }
    this.db
      .prepare(`DELETE FROM temp.search_candidate_facts WHERE id=? AND snapshot_revision=?
      AND NOT EXISTS (SELECT 1 FROM temp.search_candidates WHERE fact_id=? AND fact_revision=?)
      AND NOT EXISTS (SELECT 1 FROM temp.search_read_work WHERE fact_id=? AND fact_revision=?)`)
      .run(
        reference.id,
        reference.revision,
        reference.id,
        reference.revision,
        reference.id,
        reference.revision
      )
  }
  selected(path: string, agent: string): SessionSearchFactReference | undefined {
    const row = this.db
      .prepare(`SELECT fact_id,fact_revision FROM temp.search_candidates
      WHERE path=? AND agent=? AND selected=1 ORDER BY key LIMIT 1`)
      .get(path, agent)
    return row ? { id: Number(row.fact_id), revision: Number(row.fact_revision) } : undefined
  }
  entry(key: string): SessionSearchFactReference | undefined {
    const row = this.db
      .prepare('SELECT fact_id,fact_revision FROM temp.search_candidates WHERE key=?')
      .get(key)
    return row ? { id: Number(row.fact_id), revision: Number(row.fact_revision) } : undefined
  }
  work(path: string): SessionSearchFactReference | undefined {
    const row = this.db
      .prepare('SELECT fact_id,fact_revision FROM temp.search_read_work WHERE path=?')
      .get(path)
    return row ? { id: Number(row.fact_id), revision: Number(row.fact_revision) } : undefined
  }
}
