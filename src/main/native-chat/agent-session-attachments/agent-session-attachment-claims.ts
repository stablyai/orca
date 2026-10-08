// Which chats hold each stored attachment. A message claims the uploads it references in the same
// host transaction that makes it durable, and the sweep may delete only an upload nobody claims:
// both are synchronous statements on the host's one journal connection, so exactly one wins.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from './agent-session-attachment-references'

const CLAIM_SAVEPOINT = 'agent_session_attachment_claims'

/**
 * Created at every writable open with no `user_version` bump, like the draft table
 * (`ensureQueuedMessagesTable`): an older build ignores them and stays writable.
 * Claims are keyed by upload and chat, so a /clear carry adds the replacement as a second holder
 * and a chat's deletion frees an upload only when its last holder goes.
 */
export function ensureAgentSessionAttachmentClaimTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_session_attachment_claims (
  upload_id  TEXT    NOT NULL,
  session_id TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, session_id)
);
CREATE TABLE IF NOT EXISTS agent_session_attachment_sweeps (
  upload_id  TEXT    NOT NULL PRIMARY KEY,
  started_at INTEGER NOT NULL
);
`)
}

export class AgentSessionAttachmentExpiredError extends Error {
  constructor() {
    super('A referenced chat attachment is no longer stored on this host.')
    this.name = 'AgentSessionAttachmentExpiredError'
  }
}

export function isAgentSessionAttachmentExpiredError(
  error: unknown
): error is AgentSessionAttachmentExpiredError {
  return error instanceof AgentSessionAttachmentExpiredError
}

function uploadIsStored(root: string, uploadId: string): boolean {
  try {
    return readdirSync(join(root, uploadId)).some(
      (entry) => entry !== AGENT_SESSION_ATTACHMENT_PART_FILE
    )
  } catch {
    return false
  }
}

function isBeingSwept(db: Database.Database, uploadId: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM agent_session_attachment_sweeps WHERE upload_id = ?')
      .get(uploadId) !== undefined
  )
}

function insertClaims(
  db: Database.Database,
  uploadIds: Iterable<string>,
  sessionId: string,
  now: number
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
  )
  for (const uploadId of uploadIds) {
    insert.run(uploadId, sessionId, now)
  }
}

export type AgentSessionAttachmentClaim = {
  stateDirectory: string
  sessionId: string
  body: AgentJournalMessageItem
  /** A client's own new message: every upload of this host's store it names must still be stored,
   *  or the whole message is refused. The host's own writes (a /clear carry, a draft it sends) never refuse. */
  required: boolean
  now: number
}

/**
 * Runs inside the transaction that writes the message. Required: throws
 * `AgentSessionAttachmentExpiredError`, rolling the write back, when a reference names an upload
 * this host does not hold or is deleting. Best effort: claims what it can and reports, never
 * failing the write it rides on.
 */
export function claimAgentSessionAttachmentsInTransaction(
  db: Database.Database,
  claim: AgentSessionAttachmentClaim
): void {
  const root = agentSessionAttachmentStoreRoot(claim.stateDirectory)
  const uploadIds = agentSessionAttachmentReferences(root, claim.body)
  if (uploadIds.size === 0) {
    return
  }
  if (claim.required) {
    if (
      [...uploadIds].some(
        (uploadId) => isBeingSwept(db, uploadId) || !uploadIsStored(root, uploadId)
      )
    ) {
      throw new AgentSessionAttachmentExpiredError()
    }
    insertClaims(db, uploadIds, claim.sessionId, claim.now)
    return
  }
  db.exec(`SAVEPOINT ${CLAIM_SAVEPOINT}`)
  try {
    insertClaims(db, uploadIds, claim.sessionId, claim.now)
    db.exec(`RELEASE ${CLAIM_SAVEPOINT}`)
  } catch (error) {
    db.exec(`ROLLBACK TO ${CLAIM_SAVEPOINT}`)
    db.exec(`RELEASE ${CLAIM_SAVEPOINT}`)
    console.warn('[agent-session-attachments] claim skipped:', {
      sessionId: claim.sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** The sweep's side of the race: marks an upload as being deleted only while nobody claims it.
 *  True means this sweep won and may delete it; every later claim refuses it. */
export function markUnclaimedUploadForSweep(
  db: Database.Database,
  uploadId: string,
  now: number
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO agent_session_attachment_sweeps (upload_id, started_at)
       SELECT ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM agent_session_attachment_claims WHERE upload_id = ?)`
    )
    .run(uploadId, now, uploadId)
  return Number(result.changes) > 0
}

export function listUploadsBeingSwept(db: Database.Database): string[] {
  return db
    .prepare('SELECT upload_id FROM agent_session_attachment_sweeps')
    .all()
    .flatMap((row) =>
      typeof row === 'object' &&
      row !== null &&
      'upload_id' in row &&
      typeof row.upload_id === 'string'
        ? [row.upload_id]
        : []
    )
}

export function finishUploadSweep(db: Database.Database, uploadId: string): void {
  db.prepare('DELETE FROM agent_session_attachment_sweeps WHERE upload_id = ?').run(uploadId)
}

/**
 * Claims nothing can use any more: their chat has no record, or their upload is gone from disk
 * (removed outside Orca). Re-derived on every sweep, so a claim cannot outlive what it protects.
 * Synchronous with the facts it reads, so a claim written meanwhile is judged on today's facts.
 */
export function pruneAgentSessionAttachmentClaims(
  db: Database.Database,
  facts: { root: string; recordedSessionIds: Pick<ReadonlySet<string>, 'has'> | null }
): number {
  const rows = db
    .prepare('SELECT upload_id, session_id FROM agent_session_attachment_claims')
    .all()
    .flatMap((row) =>
      typeof row === 'object' &&
      row !== null &&
      'upload_id' in row &&
      'session_id' in row &&
      typeof row.upload_id === 'string' &&
      typeof row.session_id === 'string'
        ? [{ uploadId: row.upload_id, sessionId: row.session_id }]
        : []
    )
  const remove = db.prepare(
    'DELETE FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
  )
  let removed = 0
  for (const { uploadId, sessionId } of rows) {
    const chatGone = facts.recordedSessionIds !== null && !facts.recordedSessionIds.has(sessionId)
    if (chatGone || !existsSync(join(facts.root, uploadId))) {
      removed += Number(remove.run(uploadId, sessionId).changes)
    }
  }
  return removed
}
