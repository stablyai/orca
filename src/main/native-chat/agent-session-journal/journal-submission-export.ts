import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { JournalSubmissionInput } from './journal-store-contracts'
import type {
  JournalDomainSubmissionFacts,
  JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import {
  agentSessionAttachmentStoreRoot,
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  isAgentSessionAttachmentUploadId,
  parseAgentSessionAttachmentStorePath
} from '../agent-session-attachments/agent-session-attachment-references'

const MAX_EVENT_BYTES = 16 * 1024 * 1024

type Enrollment = { botId: string; writerEpoch: string; workspaceId: string }
const enrolled = new WeakMap<Database.Database, Enrollment>()

export function openSubmissionExport(db: Database.Database): void {
  if (
    !db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='journal_export_enrollment'"
      )
      .get()
  ) {
    return
  }
  const row = db
    .prepare(
      'SELECT bot_id,workspace_id,writer_epoch,schema_version FROM journal_export_enrollment WHERE singleton=1'
    )
    .get()
  if (!row || row.schema_version !== 1) {
    throw new Error('invalid enrolled journal version')
  }
  enrolled.set(db, {
    botId: String(row.bot_id),
    workspaceId: String(row.workspace_id),
    writerEpoch: String(row.writer_epoch)
  })
}

export function ensureSubmissionExportTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_export_enrollment (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), bot_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  writer_epoch TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS journal_submission_export (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  bot_id TEXT NOT NULL, writer_epoch TEXT NOT NULL, session_id TEXT NOT NULL,
  epoch TEXT NOT NULL, journal_sequence INTEGER NOT NULL, source_id TEXT NOT NULL,
  committed_at INTEGER NOT NULL, source_kind TEXT NOT NULL, family_id TEXT,
  predecessor TEXT REFERENCES journal_submission_export(event_id),
  original_json TEXT NOT NULL, provenance_json TEXT NOT NULL, attachments_json TEXT NOT NULL,
  UNIQUE(session_id,epoch,journal_sequence));
CREATE INDEX IF NOT EXISTS journal_submission_export_family
  ON journal_submission_export(session_id,epoch,family_id,cursor);
CREATE TABLE IF NOT EXISTS journal_export_blobs (digest TEXT PRIMARY KEY, content BLOB NOT NULL);
`)
}

type Attachment = { upload: string; name: string; size: number; sha256: string }

function retainedAttachments(
  db: Database.Database,
  stateDirectory: string,
  uploads: ReadonlySet<string>,
  limit: number
): Attachment[] {
  const result: Attachment[] = []
  for (const upload of uploads) {
    if (!isAgentSessionAttachmentUploadId(upload)) {
      throw new Error('invalid export upload identity')
    }
    const folder = resolve(agentSessionAttachmentStoreRoot(stateDirectory), upload)
    if (realpathSync(folder) !== folder) {
      throw new Error('indirect export attachment directory')
    }
    const names = readdirSync(folder).filter((name) => name !== AGENT_SESSION_ATTACHMENT_PART_FILE)
    if (names.length !== 1) {
      throw new Error('expected one committed upload')
    }
    const name = names[0]!
    const fd = openSync(
      join(folder, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) {
        throw new Error('invalid or oversized export attachment')
      }
      const content = readFileSync(fd)
      if (content.length !== stat.size) {
        throw new Error('export attachment changed')
      }
      const hash = createHash('sha256').update(content).digest('hex')
      db.prepare('INSERT OR IGNORE INTO journal_export_blobs(digest,content) VALUES(?,?)').run(
        hash,
        content
      )
      result.push({ upload, name, size: content.length, sha256: hash })
      limit -= content.length
    } finally {
      closeSync(fd)
    }
  }
  return result
}

export function recordSubmissionExport(
  db: Database.Database,
  stateDirectory: string,
  target: JournalDomainSubmissionTarget,
  facts: JournalDomainSubmissionFacts,
  input: JournalSubmissionInput,
  sequence: number,
  savedAt: number,
  familyId: string | undefined,
  uploads: ReadonlySet<string>
): void {
  const enrollment = enrolled.get(db)
  if (!enrollment) {
    return
  }
  if (!db.isTransaction || facts.identity.workspaceId !== enrollment.workspaceId) {
    throw new Error('submission does not belong to the enrolled journal')
  }
  const typedUploads = new Set<string>()
  const original: { type: string; text?: string; upload?: string }[] = []
  for (const block of input.body.blocks) {
    if (block.type === 'text') {
      original.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref' && block.path) {
      const ref = parseAgentSessionAttachmentStorePath(
        agentSessionAttachmentStoreRoot(stateDirectory),
        block.path
      )
      if (!ref || !uploads.has(ref.uploadId)) {
        throw new Error('unretained submission image')
      }
      typedUploads.add(ref.uploadId)
      original.push({ type: 'image-ref', upload: ref.uploadId })
    } else {
      throw new Error('unsupported submission block')
    }
  }
  const body = JSON.stringify(original)
  const provenance = JSON.stringify({
    from: input.body.from ?? null,
    typedBy: input.body.typedBy ?? null
  })
  const remaining = MAX_EVENT_BYTES - Buffer.byteLength(body) - Buffer.byteLength(provenance)
  if (remaining < 0) {
    throw new Error('oversized submission export')
  }
  if (uploads.size !== typedUploads.size) {
    throw new Error('enrolled submissions require typed attachment references')
  }
  const attachments = retainedAttachments(db, stateDirectory, typedUploads, remaining)
  const predecessor =
    familyId === undefined
      ? undefined
      : db
          .prepare(
            'SELECT event_id FROM journal_submission_export WHERE session_id=? AND epoch=? AND family_id=? ORDER BY cursor DESC LIMIT 1'
          )
          .get(target.sessionId, target.epoch, familyId)
  db.prepare(`INSERT INTO journal_submission_export(event_id,bot_id,writer_epoch,session_id,epoch,journal_sequence,
    source_id,committed_at,source_kind,family_id,predecessor,original_json,provenance_json,attachments_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(),
    enrollment.botId,
    enrollment.writerEpoch,
    target.sessionId,
    target.epoch,
    sequence,
    input.clientMessageId,
    savedAt,
    input.source?.kind ?? input.origin ?? 'unknown',
    familyId ?? null,
    predecessor ? String(predecessor.event_id) : null,
    body,
    provenance,
    JSON.stringify(attachments)
  )
}
