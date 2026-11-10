import { selectSessionSearchCandidates } from './session-search-catalog-selection'
import {
  SessionSearchCatalogPublications,
  type SessionSearchPublicationCommand,
  type SessionSearchPublicationResult
} from './session-search-catalog-publications'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { createHash } from 'node:crypto'
import { boundedSessionSearchPage } from './session-search-catalog-pages'

export type SessionSearchCatalogCandidate = {
  candidate: SessionFileCandidate
  root: string
  group: string
  alias: string
  sqlite: boolean
  preference: number
  sourceOrder: number
  sourcePath?: string
}

export type SessionSearchCandidateCommand =
  | { kind: 'put'; row: SessionSearchCatalogCandidate }
  | { kind: 'remove'; path: string; agents?: string[] }
  | { kind: 'path'; path: string; agent?: string | null }
  | { kind: 'group'; group: string; after?: string }
  | { kind: 'changes'; after?: string }
  | { kind: 'rerank'; root: string; agent: string; order: [string, number][]; after?: string }
  | { kind: 'consumed'; key: string; revision: number }
  | SessionSearchPublicationCommand
  | { kind: 'require'; path: string; reason?: 'force' | 'metadata' }
  | { kind: 'acknowledge'; path: string; agent: string; revision: string }
export type SessionSearchCandidateRow = SessionSearchCatalogCandidate & {
  key: string
  selected: boolean
  required: boolean
  forced: boolean
  metadata: boolean
  revision: number
}
export type SessionSearchCandidateResult = SessionSearchPublicationResult & {
  rows: SessionSearchCandidateRow[]
  pending: number
  pendingPublications: number
  after?: string
}

/** Raw alternatives and desired publication remain separate from committed search output. */
export class SessionSearchCatalogCandidates {
  private pending = 0
  private revision = 0
  private readonly publications: SessionSearchCatalogPublications
  constructor(
    private readonly db: SyncDatabase,
    removeFile: (path: string) => boolean
  ) {
    db.exec(`CREATE TEMP TABLE search_candidates (
      key TEXT PRIMARY KEY, path TEXT NOT NULL, agent TEXT NOT NULL,
      root TEXT NOT NULL, group_key TEXT NOT NULL, alias_key TEXT NOT NULL,
      candidate TEXT NOT NULL, sqlite_source INTEGER NOT NULL,
      preference INTEGER NOT NULL, source_order INTEGER NOT NULL, mtime REAL NOT NULL,
      source_path TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0, required INTEGER NOT NULL DEFAULT 0,
      force_read INTEGER NOT NULL DEFAULT 0, metadata INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX temp.search_candidate_path ON search_candidates(path,key);
    CREATE INDEX temp.search_candidate_group ON search_candidates(group_key,key);
    CREATE INDEX temp.search_candidate_alias ON search_candidates(group_key,alias_key,preference,key);
    CREATE INDEX temp.search_candidate_rank ON search_candidates(group_key,sqlite_source,mtime DESC,source_order,key);
    CREATE INDEX temp.search_candidate_changes ON search_candidates(changed,key);
    CREATE INDEX temp.search_candidate_source ON search_candidates(root,agent,group_key);
    `)
    this.publications = new SessionSearchCatalogPublications(db, removeFile)
  }

  get hasPending(): boolean {
    return this.pending > 0 || this.publications.hasPending
  }
  execute(command: SessionSearchCandidateCommand): SessionSearchCandidateResult {
    switch (command.kind) {
      case 'put':
        this.put(command.row)
        return this.result([])
      case 'path':
        return this.result(
          this.read(
            `WHERE path = ?${command.agent ? ' AND agent = ?' : ''} ORDER BY selected DESC,key LIMIT 256`,
            command.agent ? [command.path, command.agent] : [command.path]
          )
        )
      case 'group':
        return this.result(
          this.read('WHERE group_key = ? AND key > ? ORDER BY key LIMIT 256', [
            command.group,
            command.after ?? ''
          ])
        )
      case 'changes': {
        const rows = this.read('WHERE changed = 1 AND key > ? ORDER BY key LIMIT 256', [
          command.after ?? ''
        ])
        return this.result(rows)
      }
      case 'rerank': {
        if (command.after === undefined) {
          for (const [path, rank] of command.order) {
            this.db
              .prepare(
                'UPDATE temp.search_candidates SET source_order = ? WHERE root = ? AND agent = ? AND source_path = ?'
              )
              .run(rank, command.root, command.agent, path)
          }
        }
        const groups = boundedSessionSearchPage(
          this.db
            .prepare(`SELECT DISTINCT group_key FROM temp.search_candidates
          WHERE root = ? AND agent = ? AND group_key > ? AND sqlite_source = 1 ORDER BY group_key LIMIT 256`)
            .iterate(command.root, command.agent, command.after ?? ''),
          (row) => String(row.group_key)
        )
        for (const group of groups) {
          this.select(group, '', true)
        }
        return { ...this.result([]), after: groups.at(-1) }
      }
      case 'consumed':
        this.db
          .prepare(
            'UPDATE temp.search_candidates SET changed = 0 WHERE key = ? AND revision = ? AND changed = 1'
          )
          .run(command.key, command.revision)
        this.pending -= Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)
        return this.result([])
      case 'publication-begin':
      case 'publication-next':
      case 'publication-wake':
      case 'publication-update':
      case 'withdraw': {
        const result = this.publications.execute(command)
        return { ...this.result([]), ...result }
      }
      case 'require':
        this.db
          .prepare(
            `UPDATE temp.search_candidates SET required = 1${command.reason === 'force' ? ',force_read=1' : command.reason === 'metadata' ? ',metadata=1' : ''} WHERE path = ? AND selected = 1`
          )
          .run(command.path)
        this.dirtyPath(command.path)
        return this.result([])
      case 'acknowledge': {
        const row = this.read('WHERE path = ? AND agent = ? LIMIT 1', [
          command.path,
          command.agent
        ])[0]
        if (row && this.admission(row.candidate).revision === command.revision) {
          this.db
            .prepare(
              'UPDATE temp.search_candidates SET required = 0,force_read=0,metadata=0 WHERE path = ? AND agent = ? AND selected = 1'
            )
            .run(command.path, command.agent)
          this.dirtyPath(command.path)
        }
        return this.result([])
      }
      case 'remove': {
        let after = ''
        while (true) {
          const rows = this.read('WHERE path = ? AND key > ? ORDER BY key LIMIT 256', [
            command.path,
            after
          ])
          if (!rows.length) {
            break
          }
          for (const row of rows) {
            if (!command.agents || command.agents.includes(row.candidate.agent)) {
              this.pending -= Number(
                this.db
                  .prepare('SELECT changed FROM temp.search_candidates WHERE key = ?')
                  .get(row.key)?.changed ?? 0
              )
              this.db.prepare('DELETE FROM temp.search_candidates WHERE key = ?').run(row.key)
              this.select(row.group, row.alias, row.sqlite)
            }
          }
          after = rows.at(-1)!.key
        }
        return this.result([])
      }
    }
  }

  admission(candidate: SessionFileCandidate): { allowed: boolean; revision: string } {
    const rows = this.db
      .prepare(`SELECT c.key,c.selected,c.revision,p.revision AS group_revision
      FROM temp.search_candidates c LEFT JOIN temp.search_publications p ON p.group_key=c.group_key
      WHERE c.path = ? AND c.agent = ? ORDER BY c.key`)
      .iterate(candidate.file.path, candidate.agent)
    let seen = false
    let allowed = false
    const hash = createHash('sha256')
    for (const row of rows) {
      seen = true
      allowed ||= row.selected === 1
      hash.update(`${row.key}:${row.group_revision ?? row.revision}\0`)
    }
    return {
      allowed: !seen || allowed,
      revision: seen ? hash.digest('hex') : ''
    }
  }

  rowChanged(path: string): void {
    this.dirtyPath(path)
  }

  private put(row: SessionSearchCatalogCandidate): void {
    const key = `${row.group}\0${row.candidate.agent}:${row.candidate.file.path}`
    const previous = this.read('WHERE key = ?', [key])[0]
    this.db
      .prepare(`INSERT INTO temp.search_candidates
      (key,path,agent,root,group_key,alias_key,candidate,sqlite_source,preference,source_order,mtime,required,source_path)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      root=excluded.root,group_key=excluded.group_key,alias_key=excluded.alias_key,
      candidate=excluded.candidate,sqlite_source=excluded.sqlite_source,
      preference=excluded.preference,source_order=excluded.source_order,mtime=excluded.mtime,source_path=excluded.source_path`)
      .run(
        key,
        row.candidate.file.path,
        row.candidate.agent,
        row.root,
        row.group,
        row.alias,
        JSON.stringify(row.candidate),
        Number(row.sqlite),
        row.preference,
        row.sourceOrder,
        row.candidate.file.mtimeMs,
        Number(previous?.required ?? false),
        row.sourcePath ?? ''
      )
    this.select(row.group, row.alias, row.sqlite)
    if (previous && (previous.group !== row.group || previous.alias !== row.alias)) {
      this.select(previous.group, previous.alias, previous.sqlite)
    }
  }

  private select(group: string, alias: string, sqlite: boolean): void {
    this.pending += selectSessionSearchCandidates(
      this.db,
      group,
      alias,
      sqlite,
      ++this.revision,
      this.publications
    )
  }

  private dirtyPath(path: string): void {
    this.publications.rowChanged(path)
  }

  private read(where: string, values: (string | number)[]): SessionSearchCandidateRow[] {
    return boundedSessionSearchPage(
      this.db.prepare(`SELECT * FROM temp.search_candidates ${where}`).iterate(...values),
      (row) => ({
        key: String(row.key),
        root: String(row.root),
        group: String(row.group_key),
        alias: String(row.alias_key),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this private table only accepts typed candidate commands.
        candidate: JSON.parse(String(row.candidate)) as SessionFileCandidate,
        sqlite: row.sqlite_source === 1,
        preference: Number(row.preference),
        sourceOrder: Number(row.source_order),
        sourcePath: String(row.source_path),
        selected: row.selected === 1,
        required: row.required === 1,
        forced: row.force_read === 1,
        metadata: row.metadata === 1,
        revision: Number(row.revision)
      })
    )
  }

  private result(rows: SessionSearchCandidateRow[]): SessionSearchCandidateResult {
    return { rows, pending: this.pending, pendingPublications: this.publications.pending }
  }
}
