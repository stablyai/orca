import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import type { FileStat } from '../../providers/types'

export type WorkerTranscriptSourceIdentity = {
  fingerprint: string
  size: number
  mtimeMs: number
}

export const WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES = 64

export function createWorkerTranscriptBoundaryCheckpoint(bytes: Uint8Array): string {
  return createHash('sha256')
    .update('worker-transcript-boundary-v1\0')
    .update(bytes)
    .digest('base64url')
    .slice(0, 32)
}

export function workerTranscriptBoundaryCheckpointStart(offset: number): number {
  return Math.max(0, offset - WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES)
}

export function localWorkerTranscriptSourceIdentity(
  stats: BigIntStats
): WorkerTranscriptSourceIdentity | null {
  if (
    !stats.isFile() ||
    stats.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (stats.dev === 0n && stats.ino === 0n)
  ) {
    return null
  }
  return createIdentity(
    stats.dev.toString(),
    stats.ino.toString(),
    Number(stats.size),
    Number(stats.mtimeMs)
  )
}

export function remoteWorkerTranscriptSourceIdentity(
  stats: FileStat
): WorkerTranscriptSourceIdentity | null {
  const mtimeMs = stats.mtimeMs ?? stats.mtime
  if (
    stats.type !== 'file' ||
    !Number.isSafeInteger(stats.size) ||
    stats.size < 0 ||
    !Number.isSafeInteger(stats.dev) ||
    !Number.isSafeInteger(stats.ino) ||
    ((stats.dev ?? 0) === 0 && (stats.ino ?? 0) === 0) ||
    !Number.isFinite(mtimeMs)
  ) {
    return null
  }
  return createIdentity(String(stats.dev), String(stats.ino), stats.size, mtimeMs)
}

export function workerTranscriptSourceChanged(
  before: WorkerTranscriptSourceIdentity,
  after: WorkerTranscriptSourceIdentity | null,
  minimumSize: number
): boolean {
  if (!after || before.fingerprint !== after.fingerprint) {
    return true
  }
  if (after.size < before.size || after.size < minimumSize) {
    return true
  }
  // Same-size metadata movement cannot be append-only and may be an in-place replacement.
  return after.size === before.size && after.mtimeMs !== before.mtimeMs
}

function createIdentity(
  dev: string,
  ino: string,
  size: number,
  mtimeMs: number
): WorkerTranscriptSourceIdentity {
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify(['worker-transcript-file-v1', dev, ino]))
      .digest('base64url')
      .slice(0, 32),
    size,
    mtimeMs
  }
}
