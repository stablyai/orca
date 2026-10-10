import type { BigIntStats } from 'node:fs'
import type { Readable } from 'node:stream'
import { wslGatedBigIntStat } from '../native-chat/wsl-transcript-fs-snapshot'
import type { JsonlFileHandle } from './jsonl-file-access'

const SNAPSHOT_FIELDS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const

export type JsonlFileSnapshot = {
  dev: bigint
  ino: bigint
  size: number
  mtimeMs: number
  ctimeMs: number
}

export async function releaseJsonlReadStream(stream: Readable): Promise<void> {
  if (!stream.closed) {
    await new Promise<void>((resolve) => {
      stream.once('close', resolve)
      stream.destroy()
    })
  }
}

function nanosecondsToMilliseconds(value: bigint): number {
  return Number(value / 1_000_000_000n) * 1000 + Number(value % 1_000_000_000n) / 1_000_000
}

export function normalizeJsonlFileSnapshot(
  stats: Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>
): JsonlFileSnapshot {
  const size = Number(stats.size)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError('JSONL snapshot size cannot be represented as a safe byte offset.')
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size,
    mtimeMs: nanosecondsToMilliseconds(stats.mtimeNs),
    ctimeMs: nanosecondsToMilliseconds(stats.ctimeNs)
  }
}

export async function readJsonlFileSnapshot(filePath: string): Promise<JsonlFileSnapshot> {
  return normalizeJsonlFileSnapshot(await wslGatedBigIntStat(filePath, 'scan'))
}

export async function readJsonlHandleSnapshot(handle: JsonlFileHandle): Promise<JsonlFileSnapshot> {
  return normalizeJsonlFileSnapshot(await handle.stat({ bigint: true }))
}

export function sameJsonlFileSnapshot(left: JsonlFileSnapshot, right: JsonlFileSnapshot): boolean {
  return SNAPSHOT_FIELDS.every((field) => left[field] === right[field])
}

export async function rejectUnchangedJsonlFileRead(
  filePath: string,
  handle: JsonlFileHandle,
  initial: JsonlFileSnapshot
): Promise<void> {
  const [current, pathStats] = await Promise.all([
    readJsonlHandleSnapshot(handle),
    readJsonlFileSnapshot(filePath)
  ])
  if (sameJsonlFileSnapshot(initial, current) && sameJsonlFileSnapshot(initial, pathStats)) {
    throw new Error('JSONL snapshot read ended before the unchanged file boundary.')
  }
}

export async function readJsonlSnapshotRange(
  filePath: string,
  handle: JsonlFileHandle,
  initial: JsonlFileSnapshot,
  start: number,
  endExclusive: number
): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(endExclusive - start)
  let consumed = 0
  while (consumed < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      consumed,
      buffer.length - consumed,
      start + consumed
    )
    if (bytesRead === 0) {
      await rejectUnchangedJsonlFileRead(filePath, handle, initial)
      return null
    }
    consumed += bytesRead
  }
  return buffer
}

export async function verifyJsonlSnapshotContents(
  filePath: string,
  handle: JsonlFileHandle,
  initial: JsonlFileSnapshot,
  pieces: readonly Buffer[]
): Promise<boolean> {
  const current = await readJsonlSnapshotRange(filePath, handle, initial, 0, initial.size)
  if (!current) {
    return false
  }
  let consumed = 0
  for (const piece of pieces) {
    const end = consumed + piece.length
    if (end > current.length || piece.compare(current, consumed, end) !== 0) {
      return false
    }
    consumed = end
  }
  return consumed === current.length
}
