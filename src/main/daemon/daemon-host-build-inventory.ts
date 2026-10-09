import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, win32 as winPath } from 'node:path'
import { hashDaemonHostFile } from './daemon-host-file-hash-cache'
import {
  buildDaemonHostManifest,
  daemonHostExeName,
  daemonHostProcessPackageDir,
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

function collectCodeFiles(sourcePath: string, destRel: string): DaemonHostBuildFile[] {
  if (statSync(sourcePath).isFile()) {
    return [{ path: destRel, sha256: hashDaemonHostFile(sourcePath) }]
  }
  return readdirSync(sourcePath)
    .sort()
    .flatMap((name) => collectCodeFiles(join(sourcePath, name), `${destRel}/${name}`))
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

/** Hash code and its file list, without rereading the 260MB Electron image; unchanged files reuse cached hashes. */
export function collectDaemonHostBuildInventory(
  sources: DaemonHostSources
): DaemonHostBuildInventory | null {
  try {
    if (buildDaemonHostManifest(sources).some((op) => !op.optional && !existsSync(op.sourcePath))) {
      return null
    }
    const processHostDir = daemonHostProcessPackageDir(sources)
    if (!processHostExportsExist(processHostDir)) {
      return null
    }
    const files = collectCodeFiles(sources.entrySourcePath, sources.entryRelPath)
    const chunksDir = join(winPath.dirname(sources.entrySourcePath), 'chunks')
    if (existsSync(chunksDir)) {
      files.push(...collectCodeFiles(chunksDir, toPosixRelative(sources.appDir, chunksDir)))
    }
    const outManifest = join(sources.resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
    if (existsSync(outManifest)) {
      files.push(...collectCodeFiles(outManifest, toPosixRelative(sources.appDir, outManifest)))
    }
    const packageRel = toPosixRelative(sources.appDir, processHostDir)
    files.push(
      ...collectCodeFiles(join(processHostDir, 'package.json'), `${packageRel}/package.json`)
    )
    files.push(...collectCodeFiles(join(processHostDir, 'dist'), `${packageRel}/dist`))
    files.sort((left, right) => left.path.localeCompare(right.path))
    const inventory = {
      runtimeVersion: runtimeVersion(),
      executableName: daemonHostExeName(sources.execPath),
      entryRelPath: sources.entryRelPath,
      files
    }
    return { fingerprint: fingerprintInventory(inventory), ...inventory }
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

export function daemonHostBuildRuntimeMatches(
  inventory: DaemonHostBuildInventory,
  sources: DaemonHostSources
): boolean {
  return (
    inventory.runtimeVersion === runtimeVersion() &&
    inventory.executableName === daemonHostExeName(sources.execPath) &&
    inventory.entryRelPath === sources.entryRelPath &&
    inventory.files.some(
      (file) =>
        file.path ===
        `${toPosixRelative(sources.appDir, daemonHostProcessPackageDir(sources))}/package.json`
    )
  )
}

export function writeDaemonHostBuildMarker(
  root: string,
  version: string,
  inventory: DaemonHostBuildInventory
): void {
  if (!daemonHostBuildInventoryMatches(root, inventory)) {
    throw new Error('daemon-host relocation: code changed while copying')
  }
  const marker: DaemonHostBuildMarker = {
    ...inventory,
    version,
    completedAt: new Date().toISOString()
  }
  writeFileSync(join(root, DAEMON_HOST_MARKER_NAME), JSON.stringify(marker))
}
