import type { Stats } from 'node:fs'
import { stat, type FileHandle } from 'node:fs/promises'

const SNAPSHOT_FIELDS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const

export function sameJsonlFileSnapshot(left: Stats, right: Stats): boolean {
  return SNAPSHOT_FIELDS.every((field) => left[field] === right[field])
}

export async function rejectUnchangedJsonlFileRead(
  filePath: string,
  handle: FileHandle,
  initial: Stats
): Promise<void> {
  const [current, pathStats] = await Promise.all([handle.stat(), stat(filePath)])
  if (sameJsonlFileSnapshot(initial, current) && sameJsonlFileSnapshot(initial, pathStats)) {
    throw new Error('JSONL snapshot read ended before the unchanged file boundary.')
  }
}
