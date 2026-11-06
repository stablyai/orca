import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'

const INPUT_ENTITIES = {
  submissions: {
    table: 'journal_proj_submissions',
    id: 'client_message_id',
    counter: 'submissions'
  },
  receipts: { table: 'journal_proj_receipts', id: 'client_message_id', counter: 'receipts' },
  'queue.cards': { table: 'journal_proj_queue_cards', id: 'message_id', counter: 'cards' }
} as const
type InputEntity = keyof typeof INPUT_ENTITIES

export class JournalSqlInputEntities {
  constructor(private readonly scope: JournalSqlScope) {}

  for(collection: string): JournalSqlInputEntity | undefined {
    if (Object.hasOwn(INPUT_ENTITIES, collection)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fixed domain families above own these tables.
      return new JournalSqlInputEntity(this.scope, collection as InputEntity)
    }
    return undefined
  }
}

/** Current membership and retained incarnations share the entity's one typed payload home. */
export class JournalSqlInputEntity {
  private readonly table: (typeof INPUT_ENTITIES)[InputEntity]
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly collection: InputEntity
  ) {
    this.table = INPUT_ENTITIES[collection]
  }

  private id(key: string): string {
    return String(JSON.parse(key))
  }

  size(): number {
    const row = this.scope.db
      .prepare(`SELECT ${this.table.counter}_count AS size FROM journal_proj_input_entity_counters
        WHERE session_id=? AND epoch=?`)
      .get(...this.scope.prefix)
    return row ? Number(this.scope.examined(row).size) : 0
  }

  header(key: string) {
    const row = this.scope.db
      .prepare(`SELECT ordinal, incarnation FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND current=1`)
      .get(...this.scope.prefix, this.id(key))
    return row && this.scope.examined(row)
  }

  load(location: JournalSqlValueLocation) {
    const row = this.scope.db
      .prepare(`SELECT payload_json AS value_json FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
      .get(...this.scope.prefix, this.id(location.key), location.incarnation)
    return row && this.scope.examined(row)
  }

  counters(added: boolean, replaced: boolean) {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_input_entity_counters (session_id, epoch)
        VALUES (?, ?)`)
      .run(...this.scope.prefix)
    const { counter } = this.table
    return this.scope.db
      .prepare(`UPDATE journal_proj_input_entity_counters SET ${counter}_count=${counter}_count+?,
        ${counter}_ordinal=${counter}_ordinal+?, ${counter}_incarnation=${counter}_incarnation+?
        WHERE session_id=? AND epoch=?
        RETURNING ${counter}_ordinal AS next_ordinal, ${counter}_incarnation AS next_incarnation`)
      .get(Number(added), Number(added), Number(replaced), ...this.scope.prefix)!
  }

  importCounters(size: number): void {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_input_entity_counters (session_id, epoch)
        VALUES (?, ?)`)
      .run(...this.scope.prefix)
    const { counter } = this.table
    this.scope.db
      .prepare(`UPDATE journal_proj_input_entity_counters
        SET ${counter}_count=?, ${counter}_ordinal=?, ${counter}_incarnation=?
        WHERE session_id=? AND epoch=?`)
      .run(size, size, size, ...this.scope.prefix)
  }

  store(
    location: JournalSqlValueLocation,
    json: string,
    value: unknown,
    current: boolean,
    ordinal: number
  ): void {
    if (current) {
      this.scope.db
        .prepare(`UPDATE ${this.table.table} SET current=0
          WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND current=1`)
        .run(...this.scope.prefix, this.id(location.key))
    }
    this.scope.db
      .prepare(`INSERT INTO ${this.table.table}
        (session_id, epoch, ${this.table.id}, incarnation, current, ordinal, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, epoch, ${this.table.id}, incarnation)
        DO UPDATE SET current=excluded.current, payload_json=excluded.payload_json`)
      .run(
        ...this.scope.prefix,
        this.id(location.key),
        location.incarnation,
        Number(current),
        ordinal,
        json
      )
    this.columns(location, value)
  }

  update(location: JournalSqlValueLocation, json: string, value: unknown): boolean {
    const result = this.scope.db
      .prepare(`UPDATE ${this.table.table} SET payload_json=?
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
      .run(json, ...this.scope.prefix, this.id(location.key), location.incarnation)
    if (result.changes) {
      this.columns(location, value)
    }
    return !!result.changes
  }

  private columns(location: JournalSqlValueLocation, value: unknown): void {
    if (value === undefined) {
      return
    }
    const key = [...this.scope.prefix, this.id(location.key), location.incarnation]
    if (this.collection === 'submissions') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the submission map owns these payloads.
      const send = value as AgentJournalSubmission
      this.scope.db
        .prepare(`UPDATE journal_proj_submissions SET item_key=?, fingerprint=?, submitted_seq=?,
          submitted_at=?, accepted_seq=?, fence=?, dispatch_state=?, write_failure=?, recovered=?, queued_message_id=?
          WHERE session_id=? AND epoch=? AND client_message_id=? AND incarnation=?`)
        .run(
          JSON.stringify(agentJournalSubmissionKey(send.clientMessageId)),
          send.payloadFingerprint,
          send.submittedSequence ?? null,
          send.submittedAt,
          send.acceptedSequence ?? null,
          send.fence,
          send.dispatchState,
          Number(isWriteFailureSubmission(send)),
          Number(!!send.recovered),
          send.queuedMessageId ?? null,
          ...key
        )
    } else if (this.collection === 'receipts') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt map owns these payloads.
      const receipt = value as AgentJournalAcceptanceReceipt
      this.scope.db
        .prepare(`UPDATE journal_proj_receipts SET provider_item_id=?, cursor_epoch=?, cursor_seq=?, accepted_at=?
          WHERE session_id=? AND epoch=? AND client_message_id=? AND incarnation=?`)
        .run(
          receipt.providerItemId,
          receipt.cursor.epoch,
          receipt.cursor.sequence,
          receipt.acceptedAt,
          ...key
        )
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the queue card map owns these payloads.
      const card = value as QueuedMessageRow
      this.scope.db
        .prepare(`UPDATE journal_proj_queue_cards SET position=?, state=?, hold_reason=?, consumed_as=?,
          queued_epoch=?, queued_seq=? WHERE session_id=? AND epoch=? AND message_id=? AND incarnation=?`)
        .run(
          card.position,
          card.state,
          card.holdReason,
          card.consumedAs,
          card.queuedAt?.epoch ?? null,
          card.queuedAt?.sequence ?? null,
          ...key
        )
    }
  }

  delete(key: string): void {
    this.scope.db
      .prepare(`UPDATE ${this.table.table} SET current=0
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND current=1`)
      .run(...this.scope.prefix, this.id(key))
    this.scope.db
      .prepare(`UPDATE journal_proj_input_entity_counters SET ${this.table.counter}_count=${this.table.counter}_count-1
        WHERE session_id=? AND epoch=?`)
      .run(...this.scope.prefix)
  }

  remove(location: JournalSqlValueLocation): boolean {
    return !!this.scope.db
      .prepare(`DELETE FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
      .run(...this.scope.prefix, this.id(location.key), location.incarnation).changes
  }

  keys(limit = -1): string[] {
    return this.scope.db
      .prepare(`SELECT ${this.table.id} AS id FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND current=1 ORDER BY ordinal LIMIT ?`)
      .all(...this.scope.prefix, limit)
      .map((row) => JSON.stringify(this.scope.examined(row).id))
  }
}
