import { initializeSessionSearchCandidates } from './session-search-candidate-schema'
import { selectSessionSearchCandidates } from './session-search-catalog-selection'
import { SessionSearchCatalogPublications } from './session-search-catalog-publications'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import {
  sessionSearchCandidateAdmission,
  sessionSearchPathAdmission
} from './session-search-candidate-admission'
import {
  readSessionSearchCandidateRows,
  consumeSessionSearchCandidatePage
} from './session-search-candidate-rows'
import { boundedSessionSearchPage } from './session-search-catalog-pages'
import { putSessionSearchCandidate } from './session-search-candidate-entry'
import {
  sessionSearchCandidateFacts,
  type SessionSearchFactReference
} from './session-search-candidate-facts'
import { putSessionSearchCandidateBatch } from './session-search-independent-candidates'

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
    removeFile: (path: string) => boolean,
    private readonly accept?: (
      run: () => SessionSearchCandidateResult
    ) => SessionSearchCandidateResult
  ) {
    this.publications = new SessionSearchCatalogPublications(db, removeFile)
    initializeSessionSearchCandidates(db)
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
    if (
      this.accept &&
      !this.db.isTransaction &&
      ['put', 'batch', 'remove', 'rerank'].includes(command.kind)
    ) {
      return this.accept(() => this.apply(command))
    }
    return this.apply(command)
  }
  private apply(command: SessionSearchCandidateCommand): SessionSearchCandidateResult {
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
        putSessionSearchCandidateBatch(
          this.db,
          command.rows,
          this.publications,
          () => ++this.revision,
          (count) => {
            this.pending += count
          },
          (row) => {
            this.put(row)
            if (row.force) {
              this.require(row.candidate.file.path, 'force', true)
            }
            if (row.metadata) {
              this.require(row.candidate.file.path, 'metadata', true)
            }
          }
        )
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
        this.acknowledge(command.path, command.agent, command.revision, !!command.metadataOnly)
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
              const facts = sessionSearchCandidateFacts(this.db)
              const previous = facts.entry(row.key)
              this.db.prepare('DELETE FROM temp.search_candidates WHERE key = ?').run(row.key)
              facts.reclaim(previous)
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
  acknowledge(
    path: string,
    agent: string,
    revision: string,
    metadataOnly: boolean,
    publish = true
  ): { allowed: boolean; required: boolean; contentRequired: boolean } {
    const admission = sessionSearchPathAdmission(this.db, path, agent)
    if (revision === '' || admission.revision !== revision) {
      return {
        allowed: admission.allowed,
        required: admission.required,
        contentRequired: admission.contentRequired
      }
    }
    this.db
      .prepare(
        `UPDATE temp.search_candidates SET required=${metadataOnly ? 'force_read' : '0'},force_read=${metadataOnly ? 'force_read' : '0'},metadata=0 WHERE path=? AND agent=? AND selected=1`
      )
      .run(path, agent)
    if (publish) {
      this.rowChanged(path)
    }
    return {
      allowed: admission.allowed,
      required: metadataOnly && admission.contentRequired,
      contentRequired: metadataOnly && admission.contentRequired
    }
  }

  entry(key: string): SessionSearchCandidateRow | undefined {
    return this.read('WHERE key=?', [key])[0]
  }
  changedPage() {
    const references = new Map<string, SessionSearchFactReference>()
    const rows = readSessionSearchCandidateRows(
      this.db,
      'WHERE changed=1 ORDER BY mtime DESC,key LIMIT 256',
      [],
      (reference, key) => references.set(key, reference)
    )
    return { rows, references }
  }
  consumedPage(receipts: { key: string; revision: number }[]): void {
    this.pending -= consumeSessionSearchCandidatePage(this.db, receipts)
  }
  rowChanged(path: string): void {
    this.publications.rowChanged(path)
  }

  private put(row: SessionSearchCatalogCandidate): void {
    putSessionSearchCandidate(this.db, row, (group, alias, sqlite) =>
      this.select(group, alias, sqlite)
    )
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
