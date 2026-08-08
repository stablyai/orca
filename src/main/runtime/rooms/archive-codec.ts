import { createHash } from 'node:crypto'
import { strFromU8, unzip, zip, type AsyncZippable } from 'fflate'
import type { RoomMessage } from '../../../shared/rooms'

export const MAX_ROOM_ARCHIVE_BYTES = 50 * 1024 * 1024
export const ROOM_ARCHIVE_FORMAT_VERSION = 2
const MAX_ARCHIVE_FILES = 1_000
const ARCHIVE_FILES = new Set(['manifest.json', 'messages.jsonl'])

export type ArchiveJsonRecord = Record<string, unknown>

export function createArchiveZip(files: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)))
  )
}

export function extractArchiveZip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  let total = 0
  let count = 0
  return new Promise((resolve, reject) =>
    unzip(
      bytes,
      {
        filter: (file) => {
          total += file.originalSize
          count += 1
          if (total > MAX_ROOM_ARCHIVE_BYTES || count > MAX_ARCHIVE_FILES) {
            throw new Error('room_archive_too_large')
          }
          return ARCHIVE_FILES.has(file.name)
        }
      },
      (error, data) => (error ? reject(error) : resolve(data))
    )
  )
}

export function parseArchiveObject(
  input: Uint8Array | undefined,
  error: string
): ArchiveJsonRecord {
  try {
    const value = input ? JSON.parse(strFromU8(input)) : null
    if (isArchiveRecord(value)) {
      return value
    }
  } catch {}
  throw new Error(error)
}

export function parseArchiveJsonLines(input: Uint8Array | undefined): ArchiveJsonRecord[] {
  if (!input) {
    return []
  }
  return strFromU8(input)
    .split(/\r?\n/)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line)
        return isArchiveRecord(value) ? [value] : []
      } catch {
        return []
      }
    })
}

export function stableArchiveId(roomId: string, kind: string, sourceId: string): string {
  const hex = createHash('sha256')
    .update(`${roomId}\0${kind}\0${sourceId}`)
    .digest('hex')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

export function archiveUid(record: ArchiveJsonRecord): string {
  return (
    archiveString(record.uid, 256) ||
    createHash('sha256')
      .update(JSON.stringify([record.sender, record.text, record.title, record.timestamp]))
      .digest('hex')
  )
}

export function archiveTimestamp(record: ArchiveJsonRecord): number {
  const exact = archiveNumber(record.created_at_ms, 0)
  if (exact > 0) {
    return exact
  }
  const legacy = archiveNumber(record.timestamp ?? record.created_at, Date.now())
  return legacy < 10_000_000_000 ? Math.round(legacy * 1_000) : legacy
}

export function nullableArchiveTimestamp(value: unknown): number | null {
  const parsed = archiveNumber(value, 0)
  return parsed > 0 ? parsed : null
}

export function archiveMetadata(value: unknown, sourceId: string): ArchiveJsonRecord {
  if (!isArchiveRecord(value)) {
    return { importedUid: sourceId }
  }
  return JSON.stringify(value).length <= 64 * 1024
    ? { ...value, importedUid: sourceId }
    : { importedUid: sourceId }
}

export function archiveMessageKind(value: unknown): RoomMessage['kind'] {
  return ['chat', 'system', 'decision', 'proposal'].includes(String(value))
    ? (value as RoomMessage['kind'])
    : 'system'
}

export function archiveString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function archiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function isArchiveRecord(value: unknown): value is ArchiveJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
