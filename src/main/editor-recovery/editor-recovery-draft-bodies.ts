import { z } from 'zod'
import type SyncDatabase from '../sqlite/sync-database'
import {
  editorRecoveryTextPatchSchema,
  replayEditorRecoveryTextPatches,
  type EditorRecoveryTextPatch
} from '../../shared/editor-recovery-text-patch'

export const EDITOR_RECOVERY_PATCH_LIMIT = 64
const bodySchema = z.object({ content: z.string(), revision: z.number().int().positive() })

/** Bodies stay off metadata rows, so a checkpoint never rewrites unchanged body pages. */
export class EditorRecoveryDraftBodies {
  constructor(private readonly db: SyncDatabase) {}

  read(id: string, revision: number, legacyContent: unknown): string {
    const row = this.db
      .prepare('SELECT content, revision FROM editor_draft_bodies WHERE id = ?')
      .get(id)
    const body = row
      ? bodySchema.parse(row)
      : { content: z.string().parse(legacyContent), revision }
    if (body.revision > revision) {
      throw new Error('Recovery body is newer than its checkpoint')
    }
    const patches = this.db
      .prepare(`SELECT revision, base_length, start, removed, inserted, byte_length_delta
        FROM editor_draft_patches WHERE id = ? ORDER BY revision`)
      .all(id)
      .map((patch) => {
        if (
          typeof patch.revision !== 'number' ||
          patch.revision <= body.revision ||
          patch.revision > revision
        ) {
          throw new Error('Recovery patch has an invalid checkpoint revision')
        }
        return editorRecoveryTextPatchSchema.parse({
          baseLength: patch.base_length,
          start: patch.start,
          removed: patch.removed,
          inserted: JSON.parse(z.string().parse(patch.inserted)),
          byteLengthDelta: patch.byte_length_delta
        })
      })
    return replayEditorRecoveryTextPatches(z.string().parse(JSON.parse(body.content)), patches)
  }

  write(id: string, revision: number, content: string): void {
    // JSON preserves unfinished surrogate pairs as well as NUL and line endings.
    this.writeEncoded(id, revision, JSON.stringify(content))
  }

  writeEncoded(id: string, revision: number, content: string): void {
    this.db
      .prepare(`INSERT INTO editor_draft_bodies VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, revision = excluded.revision`)
      .run(id, content, revision)
    this.db.prepare('DELETE FROM editor_draft_patches WHERE id = ?').run(id)
  }

  append(id: string, revision: number, patch: EditorRecoveryTextPatch): void {
    const inserted = JSON.stringify(patch.inserted)
    this.db
      .prepare('INSERT INTO editor_draft_patches VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        revision,
        patch.baseLength,
        patch.start,
        patch.removed,
        inserted,
        patch.byteLengthDelta
      )
    const row = this.db
      .prepare(`UPDATE editor_drafts SET patch_count = patch_count + 1, patch_bytes = patch_bytes + ?
        WHERE id = ? RETURNING patch_count, patch_bytes, byte_length`)
      .get(Buffer.byteLength(inserted), id)
    const counts = z
      .object({
        patch_count: z.number(),
        patch_bytes: z.number(),
        byte_length: z.number()
      })
      .parse(row)
    if (
      counts.patch_count >= EDITOR_RECOVERY_PATCH_LIMIT ||
      counts.patch_bytes >= Math.max(64 * 1024, counts.byte_length / 2)
    ) {
      this.write(id, revision, this.read(id, revision, null))
      this.db
        .prepare('UPDATE editor_drafts SET patch_count = 0, patch_bytes = 0 WHERE id = ?')
        .run(id)
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM editor_draft_patches WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM editor_draft_bodies WHERE id = ?').run(id)
  }
}
