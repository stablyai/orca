// A member's own sidebar arrangement of cloud workspaces, stored on the account so every device
// (desktops and the phone) shows the same pins, order and sections.
//   GET /v1/team/prefs                       -> {document, revision, updatedAt}
//   PUT /v1/team/prefs {document, revision}   `revision` is the one the client edited (compare-and-set:
//                                            a stale write gets 409 and the client re-applies its edit)
// Per member, per account: switching teams switches arrangements. Ids that no longer exist are
// harmless (clients skip them) and are dropped the next time that client writes.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { WorkspaceError } from './workspaces'

const SandboxId = z.string().regex(/^sbx_[0-9a-f]{24}$/)
const SectionName = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f]+$/)

const unique = (list: readonly string[]) => new Set(list).size === list.length

export const WorkspacePrefsDocumentSchema = z
  .object({
    /** Pinned workspaces, top to bottom. */
    pinned: z.array(SandboxId).max(200).refine(unique, 'duplicate id'),
    /** Manual order of the rest (drag to reorder); workspaces not listed follow, newest first. */
    order: z.array(SandboxId).max(500).refine(unique, 'duplicate id'),
    /** Section order, including sections that are empty right now. */
    sections: z.array(SectionName).max(50).refine(unique, 'duplicate section'),
    /** Sections this member keeps collapsed. */
    collapsed: z.array(SectionName).max(50).refine(unique, 'duplicate section')
  })
  .strict()
  .refine((doc) => !doc.pinned.some((id) => doc.order.includes(id)), 'pinned ids stay out of order')

export type WorkspacePrefsDocument = z.infer<typeof WorkspacePrefsDocumentSchema>

const PutSchema = z
  .object({
    document: WorkspacePrefsDocumentSchema,
    revision: z.number().int().min(0),
    /** Which device wrote it (a label for debugging sync, never trusted for access). */
    deviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional()
  })
  .strict()

export const EMPTY_PREFS: WorkspacePrefsDocument = { pinned: [], order: [], sections: [], collapsed: [] }

type Row = { document: string; revision: number; updated_at: number }

export async function getWorkspacePrefs(db: D1Database, caller: SandboxCaller) {
  const row = await db
    .prepare('SELECT document, revision, updated_at FROM workspace_prefs WHERE account_id = ? AND user_id = ?')
    .bind(caller.accountId, caller.userId)
    .first<Row>()
  if (!row) {
    return { document: EMPTY_PREFS, revision: 0, updatedAt: null }
  }
  // A document from a newer schema parses leniently: unknown keys are ignored, bad ones reset.
  const parsed = WorkspacePrefsDocumentSchema.safeParse(JSON.parse(row.document))
  return { document: parsed.success ? parsed.data : EMPTY_PREFS, revision: row.revision, updatedAt: row.updated_at }
}

export async function putWorkspacePrefs(db: D1Database, caller: SandboxCaller, body: unknown, now: number) {
  const parsed = PutSchema.safeParse(body)
  if (!parsed.success) {
    throw new WorkspaceError('invalid_request')
  }
  const { document, revision, deviceId } = parsed.data
  const text = JSON.stringify(document)
  const result =
    revision === 0
      ? await db
          .prepare(
            `INSERT OR IGNORE INTO workspace_prefs (account_id, user_id, document, revision, updated_at, updated_by_device)
             VALUES (?, ?, ?, 1, ?, ?)`
          )
          .bind(caller.accountId, caller.userId, text, now, deviceId ?? null)
          .run()
      : await db
          .prepare(
            `UPDATE workspace_prefs SET document = ?, revision = revision + 1, updated_at = ?, updated_by_device = ?
             WHERE account_id = ? AND user_id = ? AND revision = ?`
          )
          .bind(text, now, deviceId ?? null, caller.accountId, caller.userId, revision)
          .run()
  if (result.meta.changes !== 1) {
    throw new WorkspaceError('conflict', 'stale_revision')
  }
  return getWorkspacePrefs(db, caller)
}
