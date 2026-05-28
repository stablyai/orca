import { existsSync, readFileSync, rmSync } from 'fs'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { writeSecureJsonFile } from '../../shared/secure-file'

export function writeRuntimeMetadata(userDataPath: string, metadata: RuntimeMetadata): void {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  writeMetadataFile(metadataPath, metadata)
}

export function readRuntimeMetadata(userDataPath: string): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  if (!existsSync(metadataPath)) {
    return null
  }
  return JSON.parse(readFileSync(metadataPath, 'utf-8')) as RuntimeMetadata
}

export function clearRuntimeMetadata(userDataPath: string): void {
  rmSync(getRuntimeMetadataPath(userDataPath), { force: true })
}

/**
 * Why: clearing metadata unconditionally on quit would race with a sibling
 * Orca process during auto-updater handoff (the new process may already
 * have written its own metadata before the old process finishes tearing
 * down). The ownership guard — pid + runtimeId must both match the values
 * the caller recorded at its own startup — keeps the clean-exit case honest
 * ('not_running' instead of 'stale_bootstrap') while refusing to erase the
 * replacement process's fresh bootstrap.
 *
 * Callers MUST capture `ownedPid` and `ownedRuntimeId` synchronously at
 * startup (or at least before any shutdown await) so the comparison below
 * reflects the process that actually wrote the file, not whatever state
 * globals happen to hold mid-teardown.
 */
export function clearRuntimeMetadataIfOwned(
  userDataPath: string,
  ownedPid: number,
  ownedRuntimeId: string
): void {
  const current = readRuntimeMetadata(userDataPath)
  if (!current) {
    return
  }
  if (current.pid !== ownedPid) {
    return
  }
  if (current.runtimeId !== ownedRuntimeId) {
    return
  }
  clearRuntimeMetadata(userDataPath)
}

function writeMetadataFile(path: string, metadata: RuntimeMetadata): void {
  writeSecureJsonFile(path, metadata)
}
