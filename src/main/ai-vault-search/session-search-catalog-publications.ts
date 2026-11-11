import { initializeSessionSearchStorage } from './session-search-storage-bootstrap'
import type SyncDatabase from '../sqlite/sync-database'

export type SessionSearchPublicationCommand =
  | { kind: 'publication-next' }
  | { kind: 'publication-current'; group: string }
  | { kind: 'publication-begin' }
  | { kind: 'publication-wake' }
  | {
      kind: 'publication-update'
      group: string
      revision: number
      frontier: number
      cursor: string
      phase: string
      dirty: boolean
      failed?: boolean
    }
  | { kind: 'withdraw'; group: string; revision: number; frontier: number; path: string }
export type SessionSearchPublicationResult = {
  accepted?: boolean
  publication?: { group: string; revision: number; frontier: number; cursor: string; phase: string }
}

/** Cleanup stays owed until the selected revision has actually published. */
export class SessionSearchCatalogPublications {
  pending = 0
  private retryCount = 0
  get hasPending(): boolean {
    return this.pending > 0 || this.retryCount > 0
  }
  constructor(
    private readonly db: SyncDatabase,
    private readonly removeFile: (path: string) => boolean
  ) {
    initializeSessionSearchStorage(db)
    db.exec(`CREATE TEMP TABLE search_publications (
      group_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, frontier INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1, phase TEXT NOT NULL DEFAULT 'coverage',
      cursor TEXT NOT NULL DEFAULT '', failures INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX temp.search_publication_ready ON search_publications(dirty,group_key);
    CREATE INDEX temp.search_publication_failures ON search_publications(failures,dirty,group_key);`)
  }
  execute(command: SessionSearchPublicationCommand): SessionSearchPublicationResult {
    switch (command.kind) {
      case 'publication-begin':
        this.db
          .prepare(
            'UPDATE temp.search_publications SET dirty = 1 WHERE failures > 0 AND failures < 3 AND dirty = 0'
          )
          .run()
        this.pending += this.changed()
        return {}
      case 'publication-current':
      case 'publication-next': {
        const row = this.db
          .prepare(
            `SELECT group_key,revision,frontier,cursor,phase FROM temp.search_publications WHERE ${command.kind === 'publication-current' ? 'group_key=?' : 'dirty = 1'} ORDER BY group_key LIMIT 1`
          )
          .get(...(command.kind === 'publication-current' ? [command.group] : []))
        return {
          publication: row
            ? {
                group: String(row.group_key),
                revision: Number(row.revision),
                frontier: Number(row.frontier),
                cursor: String(row.cursor),
                phase: String(row.phase)
              }
            : undefined
        }
      }
      case 'publication-wake':
        this.retryCount = 0
        this.db.prepare('UPDATE temp.search_publications SET dirty = 1 WHERE dirty = 0').run()
        this.pending += this.changed()
        this.db
          .prepare(
            "UPDATE temp.search_publications SET failures=0,phase='coverage',cursor='',frontier=frontier+1"
          )
          .run()
        return {}
      case 'publication-update': {
        const row = this.db
          .prepare(
            'SELECT dirty,failures FROM temp.search_publications WHERE group_key = ? AND revision = ? AND frontier = ?'
          )
          .get(command.group, command.revision, command.frontier)
        if (!row) {
          return { accepted: false }
        }
        const failures = Number(row.failures) + Number(command.failed ?? false)
        const dirty = Number(command.dirty && failures < 3 && !command.failed)
        this.retryCount +=
          Number(failures > 0 && failures < 3) -
          Number(Number(row.failures) > 0 && Number(row.failures) < 3)
        this.db
          .prepare(
            'UPDATE temp.search_publications SET dirty = ?,phase = ?,cursor = ?,failures = ? WHERE group_key = ? AND revision = ?'
          )
          .run(dirty, command.phase, command.cursor, failures, command.group, command.revision)
        this.pending += dirty - Number(row.dirty)
        return { accepted: true }
      }
      case 'withdraw': {
        const publication = this.db
          .prepare(
            "SELECT 1 FROM temp.search_publications WHERE group_key = ? AND revision = ? AND frontier = ? AND phase = 'withdraw' AND dirty = 1"
          )
          .get(command.group, command.revision, command.frontier)
        const selected = this.db
          .prepare('SELECT 1 FROM temp.search_candidates WHERE path = ? AND selected = 1 LIMIT 1')
          .get(command.path)
        return {
          accepted: !!publication && (selected !== undefined || this.removeFile(command.path))
        }
      }
    }
  }
  selected(group: string, revision: number, competitive: boolean): void {
    const existing = this.db
      .prepare('SELECT dirty,failures FROM temp.search_publications WHERE group_key = ?')
      .get(group)
    this.retryCount -= Number(
      Number(existing?.failures ?? 0) > 0 && Number(existing?.failures ?? 0) < 3
    )
    if (competitive) {
      this.db
        .prepare(`INSERT INTO temp.search_publications(group_key,revision)
        VALUES (?,?) ON CONFLICT(group_key) DO UPDATE SET revision=excluded.revision,dirty=1,
        phase='coverage',cursor='',failures=0,frontier=frontier+1`)
        .run(group, revision)
      this.pending += 1 - Number(existing?.dirty ?? 0)
    } else if (existing) {
      this.pending -= Number(existing.dirty)
      this.db.prepare('DELETE FROM temp.search_publications WHERE group_key = ?').run(group)
    }
  }
  rowChanged(path: string): void {
    this.db
      .prepare(`UPDATE temp.search_publications SET dirty=1,phase='coverage',cursor=''
      WHERE dirty = 0 AND failures < 3 AND group_key IN (SELECT group_key FROM temp.search_candidates WHERE path = ? AND selected = 1)`)
      .run(path)
    this.pending += this.changed()
    this.db
      .prepare(`UPDATE temp.search_publications SET phase='coverage',cursor='',frontier=frontier+1
      WHERE group_key IN (SELECT group_key FROM temp.search_candidates WHERE path = ? AND selected = 1)`)
      .run(path)
  }
  private changed(): number {
    return Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)
  }
}
