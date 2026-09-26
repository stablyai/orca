import { lstatSync } from 'node:fs'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'

export function profileStateAuthorityMarkerPath(databaseFile: string): string {
  return `${databaseFile}.authority`
}

/** Any entry at the reserved path proves this is not an untouched JSON or fresh profile. */
export function hasProfileStateAuthorityMarker(databaseFile: string): boolean {
  try {
    lstatSync(profileStateAuthorityMarkerPath(databaseFile))
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** Establish once before admitting SQLite writes; the marker carries no mutable state. */
export function ensureProfileStateAuthorityMarker(databaseFile: string): void {
  if (hasProfileStateAuthorityMarker(databaseFile)) {
    return
  }
  const path = profileStateAuthorityMarkerPath(databaseFile)
  writeFileDurableSync(durableWriteTempPath(path), path, 'sqlite\n')
}
