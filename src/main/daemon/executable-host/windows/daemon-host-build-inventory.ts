import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, win32 as winPath } from 'node:path'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { hashDaemonHostFile, hashDaemonHostFileAsync } from './daemon-host-file-hash-cache'
import {
  buildDaemonHostManifest,
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

// Bound open handles; Defender scans each opened file.
const HASH_CONCURRENCY = 8

type CodeFileSource = { sourcePath: string; destRel: string }

function listCodeFiles(sourcePath: string, destRel: string): CodeFileSource[] {
  if (statSync(sourcePath).isFile()) {
    return [{ sourcePath, destRel }]
  }
  return readdirSync(sourcePath)
    .sort()
    .flatMap((name) => listCodeFiles(join(sourcePath, name), `${destRel}/${name}`))
}

async function listCodeFilesAsync(sourcePath: string, destRel: string): Promise<CodeFileSource[]> {
  if ((await stat(sourcePath)).isFile()) {
    return [{ sourcePath, destRel }]
  }
  const names = (await readdir(sourcePath)).sort()
  const nested = await mapWithConcurrency(names, HASH_CONCURRENCY, (name) =>
    listCodeFilesAsync(join(sourcePath, name), `${destRel}/${name}`)
  )
  return nested.flat()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

function processHostExportsExist(packageDir: string): boolean {
  const manifest: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (
    !isRecord(manifest) ||
    manifest.name !== '@orca/process-host' ||
    !isRecord(manifest.exports)
  ) {
    return false
  }
  const exports = Object.values(manifest.exports)
  return (
    exports.length > 0 &&
    exports.every((entry) => {
      if (!isRecord(entry) || typeof entry.default !== 'string') {
        return false
      }
      const relative = entry.default.startsWith('./') ? entry.default.slice(2) : entry.default
      return (
        isSafeRelativePath(relative) &&
        relative.startsWith('dist/') &&
        existsSync(destPath(packageDir, relative))
      )
    })
  )
}

/** Code roots the fingerprint covers; null when the install cannot host a relocated daemon. */
function inventoryRoots(sources: DaemonHostSources): CodeFileSource[] | null {
  if (buildDaemonHostManifest(sources).some((op) => !op.optional && !existsSync(op.sourcePath))) {
    return null
  }
  const processHostDir = daemonHostProcessPackageDir(sources)
  if (!processHostExportsExist(processHostDir)) {
    return null
  }
  const roots: CodeFileSource[] = [
    { sourcePath: sources.entrySourcePath, destRel: sources.entryRelPath }
  ]
  const chunksDir = join(winPath.dirname(sources.entrySourcePath), 'chunks')
  const outManifest = join(sources.resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
  for (const optional of [chunksDir, outManifest]) {
    if (existsSync(optional)) {
      roots.push({ sourcePath: optional, destRel: toPosixRelative(sources.appDir, optional) })
    }
  }
  const packageRel = toPosixRelative(sources.appDir, processHostDir)
  roots.push(
    { sourcePath: join(processHostDir, 'package.json'), destRel: `${packageRel}/package.json` },
    { sourcePath: join(processHostDir, 'dist'), destRel: `${packageRel}/dist` }
  )
  const registryDir = daemonHostWindowsRegistryDir(sources)
  const registryRel = toPosixRelative(sources.appDir, registryDir)
  for (const relative of WINDOWS_REGISTRY_REQUIRED) {
    roots.push({
      sourcePath: destPath(registryDir, relative),
      destRel: `${registryRel}/${relative}`
    })
  }
  return roots
}

function inventoryFromFiles(
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
  sources: DaemonHostSources
): Promise<DaemonHostBuildInventory | null> {
  try {
    const roots = inventoryRoots(sources)
    if (!roots) {
      return null
    }
    const listed = await mapWithConcurrency(roots, HASH_CONCURRENCY, (root) =>
      listCodeFilesAsync(root.sourcePath, root.destRel)
    )
    const files = await mapWithConcurrency(listed.flat(), HASH_CONCURRENCY, async (file) => ({
      path: file.destRel,
      sha256: await hashDaemonHostFileAsync(file.sourcePath)
    }))
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
    const hashes = await mapWithConcurrency(inventory.files, HASH_CONCURRENCY, (file) =>
      hashDaemonHostFileAsync(destPath(root, file.path))
    )
    return hashes.every((sha256, index) => sha256 === inventory.files[index].sha256)
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
