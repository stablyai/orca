import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { DERIVED_DELIVERY_SCHEMA_SQL } from './migrate-v41'
import { REMOVED_WORK_SCHEMA_SQL } from '../reset/removed-orchestration-work-store'
import { BOT_REQUEST_SCHEMA_SQL } from '../bot-requests/bot-request-store'
import { BOT_REQUEST_OUTCOME_SCHEMA_SQL } from '../bot-requests/bot-request-outcomes'
import { BOT_CONVERSATION_ACTS_FOR_SCHEMA_SQL } from '../bot-requests/bot-conversation-acts-for-store'
import { BOT_RUN_RESEND_SCHEMA_SQL } from '../bot-requests/bot-run-resend-store'
import { REMOTE_OWNED_SCHEMA_SQL } from '../remote-owned/remote-owned-schema-sql'
import { PEER_RUN_SCHEMA_SQL } from '../peer-runs/peer-run-queue-sql'
import { WORKER_PRESENCE_SCHEMA_SQL } from '../worker-presence/worker-presence-store'
import { PAIRED_SERVER_ASKS_SCHEMA_SQL } from '../federation/paired-server-asks-store'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(
    `${createCoreTablesSql()}\n${createGraphTablesSql()}\n${REMOVED_WORK_SCHEMA_SQL}\n${BOT_REQUEST_SCHEMA_SQL}\n${BOT_REQUEST_OUTCOME_SCHEMA_SQL}\n${BOT_CONVERSATION_ACTS_FOR_SCHEMA_SQL}\n${BOT_RUN_RESEND_SCHEMA_SQL}\n${REMOTE_OWNED_SCHEMA_SQL}\n${PEER_RUN_SCHEMA_SQL}\n${WORKER_PRESENCE_SCHEMA_SQL}\n${PAIRED_SERVER_ASKS_SCHEMA_SQL}`
  )
  // Unreleased builds saved each send's fence as NOT NULL; nothing reads it, and new rows carry none.
  if (this.hasColumn('structured_mail_sends', 'fence')) {
    this.db.exec('ALTER TABLE structured_mail_sends DROP COLUMN fence')
  }
  // Unreleased builds of remote-owned workers kept an orphan-lookup fence on placements and had no settled-here mark.
  for (const column of ['reserved_by_runtime', 'outcome_unknown']) {
    if (this.hasColumn('remote_placements', column)) {
      this.db.exec(`ALTER TABLE remote_placements DROP COLUMN ${column}`)
    }
  }
  if (!this.hasColumn('remote_run_links', 'server_name')) {
    this.db.exec('ALTER TABLE remote_run_links ADD COLUMN server_name TEXT')
  }
  if (!this.hasColumn('remote_placements', 'never_sent_at')) {
    this.db.exec('ALTER TABLE remote_placements ADD COLUMN never_sent_at TEXT')
  }
  if (!this.hasColumn('remote_placements', 'sent_at')) {
    this.db.exec('ALTER TABLE remote_placements ADD COLUMN sent_at TEXT')
  }
  if (!this.hasColumn('remote_placements', 'ambiguous_sent_at')) {
    this.db.exec('ALTER TABLE remote_placements ADD COLUMN ambiguous_sent_at TEXT')
  }
  if (!this.hasColumn('remote_dispatches', 'task_settled_here')) {
    this.db.exec(
      'ALTER TABLE remote_dispatches ADD COLUMN task_settled_here INTEGER NOT NULL DEFAULT 0'
    )
  }
  this.createMailboxDeliveryIndexesIfPossible()
  this.db.exec(DERIVED_DELIVERY_SCHEMA_SQL)
}

export type CreateTablesMethods = {
  createTables: typeof createTables
}

export function attachCreateTables(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTables
  })
}
