import { createHash, randomUUID } from 'node:crypto'
import {
  MaestroContextSnapshotSchema,
  type MaestroContextSnapshot
} from '../../../../../shared/maestro-contract'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

type SnapshotScope = {
  execution_host_id: string
  workspace_key: string
  run_id: string
}

type SnapshotParams = {
  scope: SnapshotScope
  nodeId: string
  noteRevision: number
  title: string
  content: string
  ownerPrincipal: string
}

type StoredSnapshotRow = {
  snapshot_id: string
  node_id: string
  note_id: string
  note_revision: string
  content_hash: string
  owner_principal: string
  snapshot_json: string
}

type SnapshotEnvelope = {
  metadata: MaestroContextSnapshot
  markdown: string
}

export function deriveMaestroContextSnapshot(params: SnapshotParams): MaestroContextSnapshot {
  const contentHash = createHash('sha256').update(params.content, 'utf8').digest('hex')
  return MaestroContextSnapshotSchema.parse({
    note_id: params.nodeId,
    revision: `note-${params.noteRevision}`,
    content_hash: `sha256:${contentHash}`,
    media_type: 'text/markdown',
    title: params.title,
    snapshot_path: `maestro/context/${params.nodeId}/${params.noteRevision}.md`,
    byte_count: Buffer.byteLength(params.content, 'utf8')
  })
}

function buildSnapshot(params: SnapshotParams): SnapshotEnvelope {
  return {
    metadata: deriveMaestroContextSnapshot(params),
    markdown: params.content
  }
}

export function pinMaestroContextSnapshot(this: OrchestrationDb, params: SnapshotParams): string {
  if (!params.ownerPrincipal || params.ownerPrincipal.trim() === '') {
    throw new OrchestrationError('unauthorized', 'A Maestro snapshot needs an authenticated owner.')
  }
  const built = buildSnapshot(params)
  const snapshot = MaestroContextSnapshotSchema.parse(built.metadata)
  const existing = this.db
    .prepare(
      `SELECT snapshot_id FROM maestro_context_snapshots WHERE execution_host_id = ? AND workspace_key = ?
       AND run_id = ? AND note_id = ? AND note_revision = ? AND content_hash = ? AND owner_principal = ?`
    )
    .get(
      params.scope.execution_host_id,
      params.scope.workspace_key,
      params.scope.run_id,
      snapshot.note_id,
      snapshot.revision,
      snapshot.content_hash,
      params.ownerPrincipal
    ) as { snapshot_id: string } | undefined
  if (existing) {
    return existing.snapshot_id
  }

  const snapshotId = `snapshot-${randomUUID()}`
  this.db
    .prepare(
      `INSERT INTO maestro_context_snapshots (snapshot_id, execution_host_id, workspace_key, run_id, node_id, note_id, note_revision, content_hash, owner_principal, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      snapshotId,
      params.scope.execution_host_id,
      params.scope.workspace_key,
      params.scope.run_id,
      params.nodeId,
      snapshot.note_id,
      snapshot.revision,
      snapshot.content_hash,
      params.ownerPrincipal,
      JSON.stringify({ metadata: snapshot, markdown: built.markdown } satisfies SnapshotEnvelope)
    )
  return snapshotId
}

export function getMaestroContextSnapshot(
  this: OrchestrationDb,
  snapshotId: string,
  principal: MaestroPrincipal
):
  | {
      snapshotId: string
      nodeId: string
      ownerPrincipal: string
      snapshot: MaestroContextSnapshot
      markdown: string
    }
  | undefined {
  if (
    principal.authenticated !== true ||
    principal.kind !== 'coordinator' ||
    principal.generation === undefined
  ) {
    return undefined
  }
  const row = this.db
    .prepare(
      `SELECT snapshot_id, node_id, note_id, note_revision, content_hash, owner_principal, snapshot_json
       FROM maestro_context_snapshots
       WHERE snapshot_id = ? AND execution_host_id = ? AND workspace_key = ? AND run_id = ?
         AND released_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = maestro_context_snapshots.run_id AND consumer_generation = ?
         )`
    )
    .get(
      snapshotId,
      principal.workspace.execution_host_id,
      principal.workspace.workspace_key,
      principal.workspace.run_id,
      principal.generation
    ) as StoredSnapshotRow | undefined
  if (!row) {
    return undefined
  }
  let envelope: SnapshotEnvelope
  try {
    const parsed: unknown = JSON.parse(row.snapshot_json)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('metadata' in parsed) ||
      !('markdown' in parsed)
    ) {
      throw new Error('Snapshot envelope missing fields.')
    }
    const record = parsed as { metadata: unknown; markdown: unknown }
    envelope = {
      metadata: MaestroContextSnapshotSchema.parse(record.metadata),
      markdown: typeof record.markdown === 'string' ? record.markdown : ''
    }
  } catch {
    throw new OrchestrationError('integrity_error', 'Stored Maestro snapshot is malformed.')
  }
  const snapshot = envelope.metadata
  if (
    Buffer.byteLength(envelope.markdown, 'utf8') !== snapshot.byte_count ||
    `sha256:${createHash('sha256').update(envelope.markdown, 'utf8').digest('hex')}` !==
      snapshot.content_hash
  ) {
    throw new OrchestrationError('integrity_error', 'Stored Maestro snapshot content diverged.')
  }
  if (
    snapshot.note_id !== row.note_id ||
    snapshot.revision !== row.note_revision ||
    snapshot.content_hash !== row.content_hash
  ) {
    throw new OrchestrationError('integrity_error', 'Stored Maestro snapshot identity diverged.')
  }
  return {
    snapshotId: row.snapshot_id,
    nodeId: row.node_id,
    ownerPrincipal: row.owner_principal,
    snapshot,
    markdown: envelope.markdown
  }
}

export function releaseMaestroContextSnapshot(
  this: OrchestrationDb,
  snapshotId: string,
  principal: MaestroPrincipal
): boolean {
  if (
    principal.authenticated !== true ||
    principal.kind !== 'coordinator' ||
    principal.generation === undefined
  ) {
    return false
  }
  const result = this.db
    .prepare(
      `UPDATE maestro_context_snapshots SET released_at = COALESCE(released_at, datetime('now'))
       WHERE snapshot_id = ? AND execution_host_id = ? AND workspace_key = ? AND run_id = ?
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = maestro_context_snapshots.run_id AND consumer_generation = ?
         )`
    )
    .run(
      snapshotId,
      principal.workspace.execution_host_id,
      principal.workspace.workspace_key,
      principal.workspace.run_id,
      principal.generation
    )
  return result.changes === 1
}

export type MaestroContextSnapshotStoreMethods = {
  pinMaestroContextSnapshot: typeof pinMaestroContextSnapshot
  getMaestroContextSnapshot: typeof getMaestroContextSnapshot
  releaseMaestroContextSnapshot: typeof releaseMaestroContextSnapshot
}

export function attachMaestroContextSnapshotStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    pinMaestroContextSnapshot,
    getMaestroContextSnapshot,
    releaseMaestroContextSnapshot
  })
}
