import type SyncDatabase from '../sqlite/sync-database'
import { sessionSearchCandidateFacts } from './session-search-candidate-facts'

export function initializeSessionSearchCandidates(db: SyncDatabase): void {
  sessionSearchCandidateFacts(db)
  db.exec(`CREATE TEMP TABLE search_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, path TEXT NOT NULL, agent TEXT NOT NULL,
      root TEXT NOT NULL, group_key TEXT NOT NULL, alias_key TEXT NOT NULL,
      fact_id INTEGER NOT NULL, fact_revision INTEGER NOT NULL, sqlite_source INTEGER NOT NULL,
      preference INTEGER NOT NULL, source_order INTEGER NOT NULL, mtime REAL NOT NULL,
      source_path TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0, required INTEGER NOT NULL DEFAULT 0,
      force_read INTEGER NOT NULL DEFAULT 0, metadata INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX temp.search_candidate_path ON search_candidates(path,key);
    CREATE INDEX temp.search_candidate_fact ON search_candidates(fact_id,fact_revision);
    CREATE INDEX temp.search_candidate_group ON search_candidates(group_key,key);
    CREATE INDEX temp.search_candidate_alias ON search_candidates(group_key,alias_key,preference,key);
    CREATE INDEX temp.search_candidate_rank ON search_candidates(group_key,sqlite_source,mtime DESC,source_order,key);
    CREATE INDEX temp.search_candidate_changes ON search_candidates(changed,mtime DESC,key);
    CREATE INDEX temp.search_candidate_source ON search_candidates(root,agent,group_key);
    CREATE INDEX temp.search_candidate_seed ON search_candidates(root,agent,changed,mtime DESC,key);
    `)
}
