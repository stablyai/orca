import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrencyUntilFailure } from '../../../../shared/concurrency/map-with-concurrency'
import { hashDaemonHostFile, hashDaemonHostFileAsync } from './daemon-host-file-hash-cache'
import { DAEMON_HOST_FS_CONCURRENCY, listDaemonHostTree } from './daemon-host-tree-walk'
import {
  inventoryRoots,
  inventoryRootsAsync,
  isRecord,
  isSafeRelativePath,
  type CodeFileSource
} from './daemon-host-inventory-roots'
import {
  daemonHostExeName,
  daemonHostProcessPackageDir,
  daemonHostWindowsRegistryDir,
  WINDOWS_REGISTRY_REQUIRED,
  destPath,
  toPosixRelative,
  type DaemonHostSources
} from './daemon-host-manifest'

export const DAEMON_HOST_MARKER_NAME = '.materialized.json'

type DaemonHostBuildFile = { path: string; sha256: string }

export type DaemonHostBuildInventory = {
  fingerprint: string
  runtimeVersion: string
  executableName: string
  entryRelPath: string
  files: DaemonHostBuildFile[]
}

export type DaemonHostBuildMarker = DaemonHostBuildInventory & {
  version: string
  completedAt: string
}

function runtimeVersion(): string {
  return `${process.versions.electron ?? `node-${process.versions.node}`}:${process.arch}`
}

function fingerprintInventory(inventory: Omit<DaemonHostBuildInventory, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
}

function listCodeFiles(sourcePath: string, destRel: string): CodeFileSource[] {
  if (statSync(sourcePath).isFile()) {
    return [{ sourcePath, destRel }]
  }
  return readdirSync(sourcePath)
    .sort()
    .flatMap((name) => listCodeFiles(join(sourcePath, name), `${destRel}/${name}`))
}

export function inventoryFromFiles(
  sources: DaemonHostSources,
  files: DaemonHostBuildFile[]
): DaemonHostBuildInventory {
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const inventory = {
    runtimeVersion: runtimeVersion(),
    executableName: daemonHostExeName(sources.execPath),
    entryRelPath: sources.entryRelPath,
    files
  }
  return { fingerprint: fingerprintInventory(inventory), ...inventory }
}

/** Fingerprint code and layout without hashing the large Electron executable. */
export function collectDaemonHostBuildInventory(
  sources: DaemonHostSources
): DaemonHostBuildInventory | null {
  try {
    const roots = inventoryRoots(sources)
    if (!roots) {
      return null
    }
    const files = roots
      .flatMap((root) => listCodeFiles(root.sourcePath, root.destRel))
      .map((file) => ({ path: file.destRel, sha256: hashDaemonHostFile(file.sourcePath) }))
    return inventoryFromFiles(sources, files)
  } catch {
    return null
  }
}

/** Same inventory as collectDaemonHostBuildInventory, read and hashed off the event loop. */
export async function collectDaemonHostBuildInventoryAsync(
  sources: DaemonHostSources,
  knownRoots?: CodeFileSource[] | null
): Promise<DaemonHostBuildInventory | null> {
  try {
    const roots = knownRoots === undefined ? await inventoryRootsAsync(sources) : knownRoots
    if (!roots) {
      return null
    }
    const { files: listed } = await listDaemonHostTree(roots, DAEMON_HOST_FS_CONCURRENCY)
    const files = await mapWithConcurrencyUntilFailure(
      listed,
      DAEMON_HOST_FS_CONCURRENCY,
      async (file) => ({
        path: file.destRel,
        sha256: await hashDaemonHostFileAsync(file.sourcePath)
      })
    )
    return inventoryFromFiles(sources, files)
  } catch {
    return null
  }
}

function isBuildFile(value: unknown): value is DaemonHostBuildFile {
  return (
    isRecord(value) &&
    isSafeRelativePath(value.path) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  )
}

export function readDaemonHostBuildMarker(root: string): DaemonHostBuildMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, DAEMON_HOST_MARKER_NAME), 'utf8'))
    if (
      !isRecord(parsed) ||
      typeof parsed.version !== 'string' ||
      typeof parsed.completedAt !== 'string' ||
      typeof parsed.fingerprint !== 'string' ||
      typeof parsed.runtimeVersion !== 'string' ||
      !isSafeRelativePath(parsed.executableName) ||
      parsed.executableName.includes('/') ||
      !isSafeRelativePath(parsed.entryRelPath) ||
      !Array.isArray(parsed.files) ||
      !parsed.files.every(isBuildFile)
    ) {
      return null
    }
    const inventory = {
      runtimeVersion: parsed.runtimeVersion,
      executableName: parsed.executableName,
      entryRelPath: parsed.entryRelPath,
      files: parsed.files
    }
    if (parsed.fingerprint !== fingerprintInventory(inventory)) {
      return null
    }
    return {
      ...inventory,
      fingerprint: parsed.fingerprint,
      version: parsed.version,
      completedAt: parsed.completedAt
    }
  } catch {
    return null
  }
}

export function daemonHostBuildInventoryMatches(
  root: string,
  inventory: DaemonHostBuildInventory
): boolean {
  try {
    return inventory.files.every(
      (file) => hashDaemonHostFile(destPath(root, file.path)) === file.sha256
    )
  } catch {
    return false
  }
}

export async function daemonHostBuildInventoryMatchesAsync(
  root: string,
  inventory: DaemonHostBuildInventory
): Promise<boolean> {
  try {
    // A mismatch stops admitting files, as the sync verifier's every() does.
    await mapWithConcurrencyUntilFailure(
      inventory.files,
      DAEMON_HOST_FS_CONCURRENCY,
      async (file) => {
        if ((await hashDaemonHostFileAsync(destPath(root, file.path))) !== file.sha256) {
          throw new Error('daemon-host relocation: copied code does not match its marker')
        }
      }
    )
    return true
  } catch {
    return false
  }
}

export function daemonHostBuildRuntimeMatches(
  inventory: DaemonHostBuildInventory,
  sources: DaemonHostSources
): boolean {
  return (
    inventory.runtimeVersion === runtimeVersion() &&
    inventory.executableName === daemonHostExeName(sources.execPath) &&
    inventory.entryRelPath === sources.entryRelPath &&
    WINDOWS_REGISTRY_REQUIRED.every((relative) =>
      inventory.files.some(
        (file) =>
          file.path ===
          `${toPosixRelative(sources.appDir, daemonHostWindowsRegistryDir(sources))}/${relative}`
      )
    ) &&
    inventory.files.some(
      (file) =>
        file.path ===
        `${toPosixRelative(sources.appDir, daemonHostProcessPackageDir(sources))}/package.json`
    )
  )
}

/** Callers must have verified the copied code against inventory (executeManifest's expectedHashes). */
export async function writeDaemonHostBuildMarker(
  root: string,
  version: string,
  inventory: DaemonHostBuildInventory
): Promise<void> {
  const marker: DaemonHostBuildMarker = {
    ...inventory,
    version,
    completedAt: new Date().toISOString()
  }
  await writeFile(join(root, DAEMON_HOST_MARKER_NAME), JSON.stringify(marker))
}
