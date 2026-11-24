import { createHash } from 'node:crypto'

// Use 192 SHA-256 bits for practical collision resistance; this is reply identity, not authentication.
const SNAPSHOT_ID_LENGTH = 32

/** A content-derived reply id: equal serializations get equal ids across clients and restarts. */
export function contentSnapshotId(serialized: string): string {
  return createHash('sha256').update(serialized).digest('base64url').slice(0, SNAPSHOT_ID_LENGTH)
}

/** The reply, or `unchanged` when the caller already holds this exact content; the plain reply when it sent no id. */
export function resolveReplySnapshot<Reply extends object>(
  reply: Reply,
  afterSnapshotId: string | null | undefined
): Reply | (Reply & { snapshotId: string }) | { unchanged: true; snapshotId: string } {
  if (afterSnapshotId === undefined) {
    return reply
  }
  const snapshotId = contentSnapshotId(JSON.stringify(reply))
  return afterSnapshotId === snapshotId ? { unchanged: true, snapshotId } : { ...reply, snapshotId }
}
