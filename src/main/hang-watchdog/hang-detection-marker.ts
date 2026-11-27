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
import { open, rename } from 'node:fs/promises'
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

function serializeHangDetectionMarker(marker: StoredHangMarker): string {
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
  return text
}

export function writeHangDetectionMarker(markerPath: string, marker: StoredHangMarker): void {
  const text = serializeHangDetectionMarker(marker)
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

/** The watchdog's write: a stalled disk must not block the loop that escalates and spawns sample. */
export async function writeHangDetectionMarkerAsync(
  markerPath: string,
  marker: StoredHangMarker,
  // Checked right before the rename, so a newer sync write is never replaced by this older state.
  stillCurrent: () => boolean = () => true
): Promise<void> {
  const text = serializeHangDetectionMarker(marker)
  const temporaryPath = `${markerPath}.async.tmp`
  const file = await open(temporaryPath, 'w', 0o600)
  try {
    await file.chmod(0o600)
    await file.writeFile(text)
  } finally {
    await file.close()
  }
  if (stillCurrent()) {
    await rename(temporaryPath, markerPath)
  }
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

/** Coalesces watchdog writes: one in flight, the newest marker wins, nothing blocks the caller. */
export function createHangMarkerWriter(
  markerPath: string,
  // Injected so only the worker entry, which may block at shutdown, holds the sync writer.
  writeSync: (path: string, marker: StoredHangMarker) => void
): {
  write: (marker: StoredHangMarker) => void
  /** Shutdown only: if the file may lag the newest state, write it synchronously (main answered, so this is safe). */
  flushPending: (marker: StoredHangMarker) => void
} {
  let latest: StoredHangMarker | null = null
  let writing = false
  let generation = 0
  const run = (): void => {
    const marker = latest
    if (!marker) {
      return
    }
    latest = null
    writing = true
    const mine = ++generation
    void writeHangDetectionMarkerAsync(markerPath, marker, () => mine === generation)
      .catch(() => {})
      .finally(() => {
        writing = false
        run()
      })
  }
  return {
    write: (marker) => {
      latest = marker
      if (!writing) {
        run()
      }
    },
    flushPending: (marker) => {
      if (!writing && latest === null) {
        return
      }
      // Bumping the generation stops any in-flight async write from renaming over this one.
      generation++
      latest = null
      try {
        writeSync(markerPath, marker)
      } catch {
        // Optional diagnostics must not fail shutdown.
      }
    }
  }
}
