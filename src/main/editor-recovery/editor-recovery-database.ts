import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import { initializeEditorRecoverySchema } from './editor-recovery-schema'
import { EditorRecoveryDraftBodies } from './editor-recovery-draft-bodies'
import {
  editorRecoveryDraftSchema,
  editorRecoveryEntrySchema,
  editorRecoveryMetadataSchema,
  editorRecoveryStatusSchema,
  editorRecoveryResourceKey,
  type EditorRecoveryAck,
  type EditorRecoveryChange,
  type EditorRecoveryDraft,
  type EditorRecoveryEntry,
  type EditorRecoveryMetadata
} from '../../shared/editor-recovery'

export class EditorRecoveryDatabase {
  private readonly db: SyncDatabase
  private readonly bodies: EditorRecoveryDraftBodies

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new SyncDatabase(path, { timeout: 5_000 })
    try {
      initializeEditorRecoverySchema(this.db)
      this.bodies = new EditorRecoveryDraftBodies(this.db)
      hardenSqliteDatabaseFiles(path)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  list(): EditorRecoveryEntry[] {
    return this.db
      .prepare(`SELECT id, metadata, revision, updated_at, state, byte_length
        FROM editor_drafts WHERE state != 'resolved' ORDER BY updated_at DESC, id`)
      .all()
      .map((row) => editorRecoveryEntrySchema.parse(this.projectRow(row)))
  }

  read(id: string): EditorRecoveryDraft | null {
    const row = this.db
      .prepare(`SELECT id, metadata, content, content_length, revision, updated_at, state, byte_length
        FROM editor_drafts WHERE id = ? AND state != 'resolved'`)
      .get(id)
    return row ? editorRecoveryDraftSchema.parse(this.projectRow(row, true)) : null
  }

  latestActive(metadata: EditorRecoveryMetadata): EditorRecoveryDraft | null {
    const row = this.db
      .prepare(`SELECT id, metadata, content, content_length, revision, updated_at, state, byte_length
        FROM editor_drafts WHERE resource_key = ? AND state = 'active'
        ORDER BY updated_at DESC, revision DESC LIMIT 1`)
      .get(editorRecoveryResourceKey(metadata))
    return row ? editorRecoveryDraftSchema.parse(this.projectRow(row, true)) : null
  }
  status(ids: readonly string[]) {
    const query = this.db.prepare('SELECT id, revision, state FROM editor_drafts WHERE id = ?')
    return ids.flatMap((id) => {
      const row = query.get(id)
      return row ? [editorRecoveryStatusSchema.parse(row)] : []
    })
  }

  apply(changes: readonly EditorRecoveryChange[]): EditorRecoveryAck[] {
    return this.transaction(() => changes.map((change) => this.applyChange(change)))
  }

  importLegacy(drafts: readonly { metadata: EditorRecoveryMetadata; content: string }[]): void {
    this.transaction(() => {
      for (const draft of drafts) {
        const key = editorRecoveryResourceKey(draft.metadata)
        const content = JSON.stringify(draft.content)
        const id = `legacy:${createHash('sha256').update(key).update('\0').update(content).digest('hex')}`
        // Keep tombstones so a discarded legacy snapshot cannot return after another migration.
        const changed = this.db
          .prepare(`INSERT OR IGNORE INTO editor_drafts
            (id, resource_key, metadata, revision, updated_at, state, byte_length, content_length)
            VALUES (?, ?, ?, 1, 0, 'active', ?, ?)`)
          .run(
            id,
            key,
            JSON.stringify(draft.metadata),
            Buffer.byteLength(draft.content),
            draft.content.length
          )
        if (Number(changed.changes) === 1) {
          this.bodies.writeEncoded(id, 1, content)
        }
      }
    })
  }

  close(): void {
    this.db.close()
  }

  private applyChange(change: EditorRecoveryChange): EditorRecoveryAck {
    const nextRevision = change.expectedRevision + 1
    const now = Date.now()
    let changed: number | bigint
    if (change.kind === 'patch') {
      return this.applyPatch(change, nextRevision, now)
    }
    if (change.kind === 'put') {
      const metadata = JSON.stringify(change.metadata)
      const key = editorRecoveryResourceKey(change.metadata)
      const bytes = Buffer.byteLength(change.content)
      changed =
        change.expectedRevision === 0
          ? this.db
              .prepare(`INSERT OR IGNORE INTO editor_drafts
                (id, resource_key, metadata, revision, updated_at, state, byte_length, content_length)
                VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
              .run(change.id, key, metadata, now, change.state, bytes, change.content.length)
              .changes
          : this.db
              .prepare(`UPDATE editor_drafts SET resource_key = ?, metadata = ?, content = NULL,
                revision = ?, updated_at = ?, state = ?, byte_length = ?, content_length = ?,
                patch_count = 0, patch_bytes = 0
                WHERE id = ? AND revision = ? AND state != 'resolved'`)
              .run(
                key,
                metadata,
                nextRevision,
                now,
                change.state,
                bytes,
                change.content.length,
                change.id,
                change.expectedRevision
              ).changes
    } else if (change.kind === 'resolve' && change.expectedRevision === 0) {
      // A save may beat the first checkpoint; fence its ID against stale session replay.
      changed = this.db
        .prepare(`INSERT OR IGNORE INTO editor_drafts
        (id, resource_key, metadata, content, revision, updated_at, state, byte_length)
        VALUES (?, '', '{}', NULL, 1, ?, 'resolved', 0)`)
        .run(change.id, now).changes
    } else {
      changed = this.db
        .prepare(`UPDATE editor_drafts SET state = ?, content = CASE WHEN ? = 'resolved'
          THEN NULL ELSE content END, byte_length = CASE WHEN ? = 'resolved' THEN 0 ELSE byte_length END,
          revision = ?, updated_at = ? WHERE id = ? AND revision = ? AND state != 'resolved'`)
        .run(
          change.kind === 'retain' ? 'retained' : 'resolved',
          change.kind === 'retain' ? 'retained' : 'resolved',
          change.kind === 'retain' ? 'retained' : 'resolved',
          nextRevision,
          now,
          change.id,
          change.expectedRevision
        ).changes
    }
    if (Number(changed) === 1) {
      if (change.kind === 'put') {
        this.bodies.write(change.id, nextRevision, change.content)
      } else if (change.kind === 'resolve') {
        this.bodies.delete(change.id)
      }
    }
    return { id: change.id, revision: Number(changed) === 1 ? nextRevision : null }
  }

  private applyPatch(
    change: Extract<EditorRecoveryChange, { kind: 'patch' }>,
    nextRevision: number,
    now: number
  ): EditorRecoveryAck {
    if (change.start > change.baseLength || change.removed > change.baseLength - change.start) {
      return { id: change.id, revision: null }
    }
    const key = editorRecoveryResourceKey(change.metadata)
    const legacy = this.db
      .prepare(`SELECT content FROM editor_drafts WHERE id = ? AND revision = ?
        AND resource_key = ? AND state != 'resolved' AND content_length IS NULL`)
      .get(change.id, change.expectedRevision, key)
    if (legacy) {
      const content = editorRecoveryDraftSchema.shape.content.parse(
        JSON.parse(String(legacy.content))
      )
      if (content.length !== change.baseLength) {
        return { id: change.id, revision: null }
      }
      this.bodies.write(change.id, change.expectedRevision, content)
      this.db
        .prepare('UPDATE editor_drafts SET content = NULL, content_length = ? WHERE id = ?')
        .run(content.length, change.id)
    }
    const changed = this.db
      .prepare(`UPDATE editor_drafts SET metadata = ?, content_length = content_length - ? + ?,
        revision = ?, updated_at = ?, state = ?, byte_length = byte_length + ?
        WHERE id = ? AND revision = ? AND resource_key = ? AND state != 'resolved'
          AND content_length = ? AND byte_length + ? >= 0`)
      .run(
        JSON.stringify(change.metadata),
        change.removed,
        change.inserted.length,
        nextRevision,
        now,
        change.state,
        change.byteLengthDelta,
        change.id,
        change.expectedRevision,
        key,
        change.baseLength,
        change.byteLengthDelta
      )
    if (Number(changed.changes) !== 1) {
      return { id: change.id, revision: null }
    }
    if (change.removed !== 0 || change.inserted.length !== 0) {
      this.bodies.append(change.id, nextRevision, change)
    }
    return { id: change.id, revision: nextRevision }
  }

  private projectRow(
    row: Record<string, unknown>,
    includeContent = false
  ): Record<string, unknown> {
    if (typeof row.metadata !== 'string') {
      throw new Error('Invalid recovery metadata')
    }
    const content = includeContent
      ? this.bodies.read(String(row.id), Number(row.revision), row.content)
      : undefined
    if (
      content !== undefined &&
      row.content_length !== null &&
      row.content_length !== content.length
    ) {
      throw new Error('Recovery text length does not match its checkpoint')
    }
    return {
      ...editorRecoveryMetadataSchema.parse(JSON.parse(row.metadata)),
      id: row.id,
      content,
      revision: row.revision,
      updatedAt: row.updated_at,
      state: row.state,
      byteLength: row.byte_length
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      hardenSqliteDatabaseFiles(this.path)
      return result
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw error
    }
  }
}
