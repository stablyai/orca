import { selectSessionSearchCandidates } from './session-search-catalog-selection'
import { SessionSearchCatalogPublications } from './session-search-catalog-publications'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { sessionSearchCandidateAdmission } from './session-search-candidate-admission'
import { readSessionSearchCandidateRows } from './session-search-candidate-rows'
import { boundedSessionSearchPage } from './session-search-catalog-pages'

import type {
  SessionSearchCatalogCandidate,
  SessionSearchCandidateCommand,
  SessionSearchCandidateRow,
  SessionSearchCandidateResult
} from './session-search-catalog-candidate-types'
export type {
  SessionSearchCatalogCandidate,
  SessionSearchCandidateCommand,
  SessionSearchCandidateRow,
  SessionSearchCandidateResult
} from './session-search-catalog-candidate-types'

export class SessionSearchCatalogCandidates {
  private pending = 0
  private revision = 0
  private readonly publications: SessionSearchCatalogPublications
  constructor(
    private readonly db: SyncDatabase,
    removeFile: (path: string) => boolean
  ) {
    this.publications = new SessionSearchCatalogPublications(db, removeFile)
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
    CREATE INDEX temp.search_candidate_changes ON search_candidates(changed,mtime DESC,key);
    CREATE INDEX temp.search_candidate_source ON search_candidates(root,agent,group_key);
    CREATE INDEX temp.search_candidate_seed ON search_candidates(root,agent,changed,mtime DESC,key);
    `)
  }

  rollbackPoint(): () => void {
    const pending = this.pending,
      restorePublications = this.publications.rollbackPoint()
    return () => {
      this.pending = pending
      restorePublications()
    }
  }
  get hasPending(): boolean {
    return this.pending > 0 || this.publications.hasPending
  }
  execute(command: SessionSearchCandidateCommand): SessionSearchCandidateResult {
    switch (command.kind) {
      case 'publication-step':
      case 'admit':
      case 'remove-page':
      case 'unowned-page':
        throw new Error('Candidate admission requires the owning search store')
      case 'contested':
        return {
          ...this.result([]),
          contested: command.rows
            .filter(({ group, path }) =>
              this.db
                .prepare(
                  'SELECT 1 FROM temp.search_candidates WHERE group_key=? AND path<>? LIMIT 1'
                )
                .get(group, path)
            )
            .map(({ path }) => path)
        }
      case 'batch':
        for (const row of command.rows) {
          this.put(row)
          if (row.force) {
            this.require(row.candidate.file.path, 'force', true)
          }
          if (row.metadata) {
            this.require(row.candidate.file.path, 'metadata', true)
          }
        }
        return this.result([])
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
        const scoped = command.root !== undefined && command.agent !== undefined
        const rows = this.read(
          `WHERE changed = 1 AND key > ?${scoped ? ' AND root=? AND agent=?' : ''} ORDER BY mtime DESC,key LIMIT 256`,
          scoped ? [command.after ?? '', command.root!, command.agent!] : [command.after ?? '']
        )
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
      case 'publication-current':
      case 'publication-wake':
      case 'publication-update':
      case 'withdraw': {
        const result = this.publications.execute(command)
        return { ...this.result([]), ...result }
      }
      case 'require':
        this.require(command.path, command.reason, command.delivered)
        return this.result([])
      case 'acknowledge': {
        const row = this.read('WHERE path = ? AND agent = ? LIMIT 1', [
          command.path,
          command.agent
        ])[0]
        if (row && this.admission(row.candidate).revision === command.revision) {
          this.db
            .prepare(
              `UPDATE temp.search_candidates SET required = ${command.metadataOnly ? 'force_read' : '0'},force_read=${command.metadataOnly ? 'force_read' : '0'},metadata=0 WHERE path = ? AND agent = ? AND selected = 1`
            )
            .run(command.path, command.agent)
          this.rowChanged(command.path)
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

  admission(candidate: SessionFileCandidate) {
    return sessionSearchCandidateAdmission(this.db, candidate)
  }

  entry(key: string): SessionSearchCandidateRow | undefined {
    return this.read('WHERE key=?', [key])[0]
  }
  rowChanged(path: string): void {
    this.publications.rowChanged(path)
  }

  private put(row: SessionSearchCatalogCandidate): void {
    const key = `${row.group}\0${row.candidate.agent}:${row.candidate.file.path}`
    const previous = this.read('WHERE key = ?', [key])[0]
    if (
      previous &&
      JSON.stringify(previous.candidate) === JSON.stringify(row.candidate) &&
      previous.root === row.root &&
      previous.alias === row.alias &&
      previous.sqlite === row.sqlite &&
      previous.preference === row.preference &&
      previous.sourceOrder === row.sourceOrder &&
      previous.sourcePath === (row.sourcePath ?? '')
    ) {
      return
    }
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

  private require(path: string, reason?: 'force' | 'metadata', delivered = false): void {
    const predicate = delivered
      ? ''
      : ` AND (required=0${reason === 'force' ? ' OR force_read=0' : reason === 'metadata' ? ' OR metadata=0' : ''})`
    const previouslyClean = Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM temp.search_candidates WHERE path=? AND selected=1 AND changed=0${predicate}`
        )
        .get(path)?.n ?? 0
    )
    this.db
      .prepare(
        `UPDATE temp.search_candidates SET required=1,changed=1,revision=?${reason === 'force' ? ',force_read=1' : reason === 'metadata' ? ',metadata=1' : ''} WHERE path=? AND selected=1${predicate}`
      )
      .run(++this.revision, path)
    if (Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)) {
      this.pending += previouslyClean
      this.rowChanged(path)
    }
  }

  private read(where: string, values: (string | number)[]): SessionSearchCandidateRow[] {
    return readSessionSearchCandidateRows(this.db, where, values)
  }

  private result(rows: SessionSearchCandidateRow[]): SessionSearchCandidateResult {
    return { rows, pending: this.pending, pendingPublications: this.publications.pending }
  }
}
