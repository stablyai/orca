// Bot items on this host (bot-items.sqlite, next to bot-work.sqlite): one row of current state per
// item and an append-only event log, each write one transaction with any mail it owes. The status machine and who may write which field are enforced inside those transactions.
import SyncDatabase from '../sqlite/sync-database'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../shared/agent-session/agent-session-attachments'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import { BotItemError } from './bot-item-error'
import { ensureKeptWaitingAsks } from './bot-item-waiting-ask-keep'
import { migrateBotItems } from './bot-items-schema'
import { BotItemsOwner } from './bot-items-owner'
import { ownerCommentAttachmentBody } from './bot-item-comment-attachment-body'
import { agentSessionAttachmentReferences } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { eventRecordOf } from './bot-items-rows'

export { BotItemError }

const OWED_ATTACHMENT_COMMENTS = `mail = 'owed' AND kind = 'commented'
  AND json_extract(actor, '$.kind') = 'owner'
  AND (json_array_length(data, '$.images') > 0
    OR instr(lower(json_extract(data, '$.text')), '${AGENT_SESSION_ATTACHMENTS_DIR_NAME}') > 0)`

export class BotItemsStore extends BotItemsOwner {
  /** The file lives in the profile folder, which exists before any runtime reads it. */
  static open(path: string): BotItemsStore {
    const db = new SyncDatabase(path)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    const writable = migrateBotItems(db)
    if (writable) {
      ensureKeptWaitingAsks(db)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_item_events_comment_request
        ON item_events(item_uid, json_extract(data, '$.requestId'))
        WHERE kind = 'commented' AND json_extract(data, '$.requestId') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_item_events_owed_attachment_comments
        ON item_events(id) WHERE ${OWED_ATTACHMENT_COMMENTS}`)
    }
    if (path !== ':memory:') {
      hardenSqliteDatabaseFiles(path)
    }
    return new BotItemsStore(db, !writable)
  }

  /** Accepted uploads stay with the outbox until mail has custody, even when the first chat is deleted. */
  owedCommentAttachmentUploads(root: string): string[] {
    const uploads = new Set<string>()
    const rows = this.db
      .prepare(`SELECT * FROM item_events WHERE ${OWED_ATTACHMENT_COMMENTS} ORDER BY id`)
      .iterate()
    for (const row of rows) {
      const body = ownerCommentAttachmentBody(eventRecordOf(row))
      if (body) {
        for (const id of agentSessionAttachmentReferences(root, body)) {
          uploads.add(id)
        }
      }
    }
    return [...uploads]
  }
}
