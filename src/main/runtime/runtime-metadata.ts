import { existsSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

/** Off-thread twin of {@link readRuntimeMetadata} for pollers; a missing file is not an error. */
export async function readRuntimeMetadataAsync(
  userDataPath: string
): Promise<RuntimeMetadata | null> {
  let raw: string
  try {
    raw = await readFile(getRuntimeMetadataPath(userDataPath), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  return JSON.parse(raw) as RuntimeMetadata
}

export function clearRuntimeMetadata(userDataPath: string): void {
  rmSync(getRuntimeMetadataPath(userDataPath), { force: true })
}

/** Clear only matching startup pid/runtimeId so old-process teardown cannot erase updater handoff metadata.
 * Capture both synchronously before shutdown awaits; teardown globals may already describe a replacement. */
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
