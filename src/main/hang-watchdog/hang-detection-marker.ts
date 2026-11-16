import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  asHangObservations,
  latestHangMarker,
  parseLegacyHangMarker,
  type HangDetectionMarker,
  type HangObservationCollection
} from './hang-observations'

export type { HangDetectionMarker } from './hang-observations'
export type StoredHangMarker = HangDetectionMarker | HangObservationCollection

export function hangDetectionMarkerPath(userDataPath: string): string {
  return join(userDataPath, 'main-thread-hang.json')
}

export function writeHangDetectionMarker(markerPath: string, marker: StoredHangMarker): void {
  const collection = 'version' in marker ? asHangObservations(marker) : null
  if (
    'version' in marker &&
    (!collection || collection.observations.length !== marker.observations.length)
  ) {
    throw new Error('Invalid hang observations')
  }
  const text = JSON.stringify(
    collection ? { ...latestHangMarker(collection), ...collection } : marker
  )
  if (Buffer.byteLength(text) > 32 * 1024) {
    throw new Error('Hang observations exceed byte bound')
  }
  const temporaryPath = `${markerPath}.tmp`
  const fd = openSync(temporaryPath, 'w', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
  renameSync(temporaryPath, markerPath)
}

export function readAvailableHangDetectionMarker(
  markerPath: string
): StoredHangMarker | null | undefined {
  let raw: string
  try {
    if (statSync(markerPath).size > 64 * 1024) {
      return null
    }
    raw = readFileSync(markerPath, 'utf8')
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? null
      : undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed && 'version' in parsed && parsed.version === 1) {
      const collection = Buffer.byteLength(raw) <= 32 * 1024 ? asHangObservations(parsed) : null
      return collection ? { ...latestHangMarker(collection), ...collection } : null
    }
    return parseLegacyHangMarker(parsed)
  } catch {
    return null
  }
}

export function consumeHangDetectionMarker(markerPath: string): StoredHangMarker | null {
  const marker = readAvailableHangDetectionMarker(markerPath)
  // Retry unavailable reads next startup; only successfully inspected files are consumable.
  if (marker === undefined) {
    return null
  }
  try {
    rmSync(markerPath, { force: true })
  } catch {
    // A marker that cannot be deleted may produce a duplicate breadcrumb, but cannot block startup.
  }
  return marker
}
