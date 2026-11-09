// Org-synced prompts and PR instructions: one small document per org account.
//   GET /v1/team/prompts                      -> {document, revision, updatedAt, updatedBy}
//   PUT /v1/team/prompts {document, revision}  org owner/admin; `revision` is the one you edited
//                                             (compare-and-set, so two admins never silently clobber)
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { WorkspaceError, isOrgAdmin } from './workspaces'

const Text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/)

export const OrgPromptsDocumentSchema = z
  .object({
    prompts: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            name: Text(80).min(1),
            body: Text(8000).min(1)
          })
          .strict()
      )
      .max(50),
    /** Appended to every agent's instructions when it opens or updates a pull request. */
    prInstructions: Text(8000)
  })
  .strict()
  .refine((doc) => new Set(doc.prompts.map((p) => p.id)).size === doc.prompts.length, 'duplicate prompt id')

const PutSchema = z.object({ document: OrgPromptsDocumentSchema, revision: z.number().int().min(0) }).strict()

const EMPTY = { prompts: [], prInstructions: '' }

type Row = { document: string; revision: number; updated_at: number; updated_by: string }

function requireOrg(caller: SandboxCaller): string {
  if (!caller.orgId) {
    throw new WorkspaceError('invalid_request', 'personal_account')
  }
  return caller.accountId
}

export async function getOrgPrompts(db: D1Database, caller: SandboxCaller) {
  const accountId = requireOrg(caller)
  const row = await db.prepare('SELECT * FROM org_prompts WHERE account_id = ?').bind(accountId).first<Row>()
  return row
    ? { document: JSON.parse(row.document), revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by }
    : { document: EMPTY, revision: 0, updatedAt: null, updatedBy: null }
}

export async function putOrgPrompts(db: D1Database, caller: SandboxCaller, body: unknown, now: number) {
  const accountId = requireOrg(caller)
  if (!isOrgAdmin(caller)) {
    throw new WorkspaceError('forbidden', 'admin_only')
  }
  const parsed = PutSchema.safeParse(body)
  if (!parsed.success) {
    throw new WorkspaceError('invalid_request')
  }
  const { document, revision } = parsed.data
  const text = JSON.stringify(document)
  const result =
    revision === 0
      ? await db
          .prepare('INSERT OR IGNORE INTO org_prompts (account_id, document, revision, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)')
          .bind(accountId, text, now, caller.userId)
          .run()
      : await db
          .prepare('UPDATE org_prompts SET document = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE account_id = ? AND revision = ?')
          .bind(text, now, caller.userId, accountId, revision)
          .run()
  if (result.meta.changes !== 1) {
    throw new WorkspaceError('conflict', 'stale_revision')
  }
  return getOrgPrompts(db, caller)
}
