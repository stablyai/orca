// Claim writes and sweep marks share the journal transaction connection so only one can win.

import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from './agent-session-attachment-references'

const CLAIM_SAVEPOINT = 'agent_session_attachment_claims'

/** Add tables without user_version changes so older builds stay writable; multiple chats may hold uploads. */
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
  /** New client references must exist; host carries/drafts claim best effort. */
  required: boolean
  /** Existing references remain best effort when replacing a message. */
  previous?: AgentJournalMessageItem
  now: number
}

/** Share the message transaction so missing required uploads roll back the entire send. */
export function claimAgentSessionAttachmentsInTransaction(
  db: Database.Database,
  claim: AgentSessionAttachmentClaim
): void {
  const root = agentSessionAttachmentStoreRoot(claim.stateDirectory)
  const uploadIds = agentSessionAttachmentReferences(root, claim.body)
  if (uploadIds.size === 0) {
    return
  }
  const kept = claim.previous
    ? agentSessionAttachmentReferences(root, claim.previous)
    : new Set<string>()
  const required = claim.required ? [...uploadIds].filter((id) => !kept.has(id)) : []
  if (required.some((uploadId) => isBeingSwept(db, uploadId) || !uploadIsStored(root, uploadId))) {
    throw new AgentSessionAttachmentExpiredError()
  }
  insertClaims(db, required, claim.sessionId, claim.now)
  const bestEffort = [...uploadIds].filter((id) => !required.includes(id))
  if (bestEffort.length === 0) {
    return
  }
  db.exec(`SAVEPOINT ${CLAIM_SAVEPOINT}`)
  try {
    insertClaims(db, bestEffort, claim.sessionId, claim.now)
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

/** Mark only unclaimed uploads; subsequent claims must refuse them. */
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

/** Recheck chat and disk facts on each sweep so orphan claims cannot preserve unused uploads. */
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
    let uploadGone = chatGone
    try {
      if (!chatGone) {
        lstatSync(join(facts.root, uploadId))
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      uploadGone = true
    }
    if (uploadGone) {
      removed += Number(remove.run(uploadId, sessionId).changes)
    }
  }
  return removed
}
