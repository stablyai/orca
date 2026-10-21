import type Database from '../../sqlite/sync-database'
import { generateId } from '../orchestration/db/generated-id'
import { InvalidArgumentError } from '../rpc/core'
import {
  WORK_INBOX_LIST_MAX,
  WORK_INBOX_OPTIONS_MAX,
  WORK_INBOX_OPTION_MAX_LENGTH,
  type WorkInboxAnswerParams,
  type WorkInboxCancelParams,
  type WorkInboxItem,
  type WorkInboxListParams,
  type WorkInboxListResult,
  type WorkInboxMutationResult
} from '../../../shared/work-inbox'
import { parseOptions, toItem, type WorkInboxAsker, type WorkInboxRow } from './work-inbox-row'

export { WORK_INBOX_SCHEMA_SQL, type WorkInboxAsker } from './work-inbox-row'

/** Durable human-answer queue; every transition is a compare-and-set on `revision`. */
export class WorkInboxStore {
  constructor(private readonly db: Database.Database) {}

  private readRow(id: string): WorkInboxRow | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * from the table whose columns WorkInboxRow mirrors.
    return this.db.prepare('SELECT * FROM work_inbox_items WHERE id = ?').get(id) as
      | WorkInboxRow
      | undefined
  }

  private requireItem(id: string): WorkInboxItem {
    const row = this.readRow(id)
    if (!row) {
      throw new Error(`Work inbox item ${id} vanished inside its own transaction.`)
    }
    return toItem(row)
  }

  get(id: string): WorkInboxItem | undefined {
    const row = this.readRow(id)
    return row ? toItem(row) : undefined
  }

  create(args: {
    asker: WorkInboxAsker
    question: string
    optionLabels: string[]
    allowFreeText: boolean
    requestId?: string
    now: number
  }): WorkInboxItem {
    return this.transaction(() => this.createInTransaction(args))
  }

  private createInTransaction(args: Parameters<WorkInboxStore['create']>[0]): WorkInboxItem {
    if (args.requestId) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * from the table whose columns WorkInboxRow mirrors.
      const prior = this.db
        .prepare('SELECT * FROM work_inbox_items WHERE asker_handle = ? AND ask_request_id = ?')
        .get(args.asker.handle, args.requestId) as WorkInboxRow | undefined
      if (prior) {
        const priorLabels = parseOptions(prior.options).map((option) => option.label)
        const sameIntent =
          prior.question === args.question &&
          (prior.allow_free_text === 1) === args.allowFreeText &&
          JSON.stringify(priorLabels) === JSON.stringify(args.optionLabels)
        if (!sameIntent) {
          throw new InvalidArgumentError(
            `Request ${args.requestId} already asked a different question (${prior.id}).`
          )
        }
        return toItem(prior)
      }
    }
    if (args.optionLabels.length > WORK_INBOX_OPTIONS_MAX) {
      throw new InvalidArgumentError(`At most ${WORK_INBOX_OPTIONS_MAX} options are allowed.`)
    }
    if (args.optionLabels.some((label) => label.length > WORK_INBOX_OPTION_MAX_LENGTH)) {
      throw new InvalidArgumentError('An answer option exceeds the allowed length.')
    }
    if (args.optionLabels.length === 0 && !args.allowFreeText) {
      throw new InvalidArgumentError('A question without options must allow a free-text answer.')
    }
    const options = args.optionLabels.map((label, index) => ({ id: `opt_${index + 1}`, label }))
    const id = generateId('wib')
    this.db
      .prepare(
        `INSERT INTO work_inbox_items (
           id, asker_handle, asker_pane_key, project_id, project_label, worktree_id, agent_kind,
           question, options, allow_free_text, ask_request_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        args.asker.handle,
        args.asker.paneKey,
        args.asker.projectId,
        args.asker.projectLabel,
        args.asker.worktreeId,
        args.asker.agentKind,
        args.question,
        JSON.stringify(options),
        args.allowFreeText ? 1 : 0,
        args.requestId ?? null,
        args.now
      )
    return this.requireItem(id)
  }

  list(params: WorkInboxListParams): WorkInboxListResult {
    const view = params.view ?? 'open'
    const conditions = [view === 'open' ? "status = 'open'" : "status != 'open'"]
    const values: (string | number)[] = []
    if (params.id) {
      conditions.push('id = ?')
      values.push(params.id)
    }
    if (params.projectId) {
      conditions.push('project_id = ?')
      values.push(params.projectId)
    }
    if (params.agentId) {
      conditions.push('asker_handle = ?')
      values.push(params.agentId)
    }
    const limit = Math.min(params.limit ?? 50, WORK_INBOX_LIST_MAX)
    // Why: open is a queue (oldest waits longest); history reads as a log.
    const order = view === 'open' ? 'created_at ASC, rowid ASC' : 'created_at DESC, rowid DESC'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * from the table whose columns WorkInboxRow mirrors.
    const rows = this.db
      .prepare(
        `SELECT * FROM work_inbox_items WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ?`
      )
      .all(...values, limit) as WorkInboxRow[]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT(*) always yields one row with the aliased column.
    const { count } = this.db
      .prepare("SELECT COUNT(*) AS count FROM work_inbox_items WHERE status = 'open'")
      .get() as { count: number }
    return { items: rows.map(toItem), openCount: count }
  }

  answer(params: WorkInboxAnswerParams, now: number): WorkInboxMutationResult {
    return this.transaction(() => {
      const row = this.readRow(params.id)
      if (!row) {
        return { status: 'not-found' }
      }
      const text = params.text?.trim() ? params.text : undefined
      // Why: a retried request (lost response, double click) must not read as a conflict with itself,
      // but a reused key carrying a different answer is a new intent and must not be absorbed.
      if (row.answer_request_id === params.clientRequestId) {
        const sameIntent =
          row.answer_option_id === (params.optionId ?? null) && row.answer_text === (text ?? null)
        return { status: sameIntent ? 'ok' : 'conflict', item: toItem(row) }
      }
      if (row.status !== 'open' || row.revision !== params.expectedRevision) {
        return { status: 'conflict', item: toItem(row) }
      }
      const options = parseOptions(row.options)
      if (params.optionId !== undefined && !options.some((o) => o.id === params.optionId)) {
        throw new InvalidArgumentError(`Unknown option ${params.optionId} for ${row.id}.`)
      }
      if (text !== undefined && row.allow_free_text !== 1) {
        throw new InvalidArgumentError(`${row.id} accepts only one of its options.`)
      }
      this.db
        .prepare(
          `UPDATE work_inbox_items
           SET status = 'answered', revision = revision + 1, answer_option_id = ?, answer_text = ?,
               answer_request_id = ?, answered_at = ?
           WHERE id = ? AND status = 'open' AND revision = ?`
        )
        .run(
          params.optionId ?? null,
          text ?? null,
          params.clientRequestId,
          now,
          row.id,
          params.expectedRevision
        )
      return { status: 'ok', item: this.requireItem(row.id) }
    })
  }

  cancel(params: WorkInboxCancelParams, now: number): WorkInboxMutationResult {
    return this.transaction(() => {
      const row = this.readRow(params.id)
      if (!row) {
        return { status: 'not-found' }
      }
      if (row.status === 'cancelled') {
        return { status: 'ok', item: toItem(row) }
      }
      if (row.status !== 'open' || row.revision !== params.expectedRevision) {
        return { status: 'conflict', item: toItem(row) }
      }
      this.db
        .prepare(
          `UPDATE work_inbox_items
           SET status = 'cancelled', revision = revision + 1, cancelled_at = ?
           WHERE id = ? AND status = 'open'`
        )
        .run(Math.max(now, (row.cancelled_at ?? 0) + 1), row.id)
      return { status: 'ok', item: this.requireItem(row.id) }
    })
  }

  /** Reopen only a closed, unanswered question; the last closure remains in its history. */
  reopen(params: WorkInboxCancelParams): WorkInboxMutationResult {
    return this.transaction(() => {
      const row = this.readRow(params.id)
      if (!row) {
        return { status: 'not-found' }
      }
      if (row.status === 'open' && row.revision === params.expectedRevision + 1) {
        return { status: 'ok', item: toItem(row) }
      }
      if (row.status !== 'cancelled' || row.revision !== params.expectedRevision) {
        return { status: 'conflict', item: toItem(row) }
      }
      this.db
        .prepare(
          "UPDATE work_inbox_items SET status = 'open', revision = revision + 1 WHERE id = ? AND status = 'cancelled' AND revision = ?"
        )
        .run(row.id, params.expectedRevision)
      return { status: 'ok', item: this.requireItem(row.id) }
    })
  }

  /** The asking agent confirmed it received the answer; repeating it is a no-op `ok`. */
  acknowledge(id: string, now: number): WorkInboxMutationResult {
    return this.transaction(() => {
      const row = this.readRow(id)
      if (!row) {
        return { status: 'not-found' }
      }
      if (row.status === 'delivered') {
        return { status: 'ok', item: toItem(row) }
      }
      if (row.status !== 'answered') {
        return { status: 'conflict', item: toItem(row) }
      }
      this.db
        .prepare(
          `UPDATE work_inbox_items
           SET status = 'delivered', revision = revision + 1, delivered_at = ?
           WHERE id = ? AND status = 'answered'`
        )
        .run(now, id)
      return { status: 'ok', item: this.requireItem(id) }
    })
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
