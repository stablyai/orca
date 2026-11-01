import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, win32 as winPath } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  buildDaemonHostManifest,
  daemonHostFitsPathBudget,
  destPath,
  executeManifest,
  toPosixRelative,
  WINDOWS_PROCESS_TREE_REQUIRED,
  type DaemonHostSources
} from './daemon-host-manifest'
import {
  collectDaemonHostBuildInventory,
  daemonHostBuildInventoryMatches,
  daemonHostBuildRuntimeMatches,
  readDaemonHostBuildMarker,
  writeDaemonHostBuildMarker
} from './daemon-host-build-inventory'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import {
  daemonHostStagingName,
  reclaimAbandonedDaemonHostStaging,
  reclaimUnownedDaemonHostDir
} from './daemon-host-reclaim'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { quarantineCorruptDaemonPidRecord } from './daemon-pid-record-quarantine'
import { inspectProcessLiveness, mergeProcessLivenessVerdict } from './daemon-process-inspection'

// Copy the Electron runtime outside NSIS's install-directory kill zone; failures fall back to the install runtime.

export type RelocatedDaemonHost = {
  execPath: string
  entryPath: string
}

const HOST_SUBDIR = 'daemon-host'
const observedBuilds = new Map<string, { fingerprint: string; entrySourcePath: string }>()

function observedBuildKey(sources: Pick<DaemonHostSources, 'execPath' | 'resourcesPath'>): string {
  return JSON.stringify([
    getAppEnvironment().getVersion(),
    sources.execPath,
    sources.resourcesPath,
    process.versions.electron ?? `node-${process.versions.node}`,
    process.arch
  ])
}

function currentBuildFingerprint(
  sources: DaemonHostSources,
  sourceFingerprint: string | null
): string | null {
  const key = observedBuildKey(sources)
  if (sourceFingerprint !== null) {
    observedBuilds.set(key, {
      fingerprint: sourceFingerprint,
      entrySourcePath: sources.entrySourcePath
    })
    return sourceFingerprint
  }
  // Reuse the observed fingerprint after source removal; app version alone cannot select a build.
  const observed = observedBuilds.get(key)
  return observed?.entrySourcePath === sources.entrySourcePath ? observed.fingerprint : null
}

// Keep runtimes out of roaming storage; match the NSIS uninstall root in config/nsis/orca-installer-hooks.nsh.
const LOCAL_HOST_ROOT_NAME = 'Orca'

// Match getDaemonEntryPath() so relocation copies the same entry the install runtime would fork.
function resolveEntrySourcePath(resourcesPath: string, observedEntryPath?: string): string {
  const unpackedRoot = join(resourcesPath, 'app.asar.unpacked')
  const direct = join(unpackedRoot, 'daemon-entry.js')
  if (existsSync(direct)) {
    return direct
  }
  const nested = join(unpackedRoot, 'out', 'main', 'daemon-entry.js')
  return existsSync(nested) ? nested : (observedEntryPath ?? nested)
}

/** orcad is packaged plain Node; require an Electron asar root before attempting relocation. */
function isPackagedElectronWin32(): boolean {
  const environment = getAppEnvironment()
  return (
    process.platform === 'win32' &&
    environment.isPackaged() &&
    environment.getAppPath().includes('app.asar')
  )
}

function collectDaemonHostSources(): DaemonHostSources | null {
  if (!isPackagedElectronWin32()) {
    return null
  }
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
    return null
  }
  const execPath = process.execPath
  const appDir = winPath.dirname(execPath)
  const observed = observedBuilds.get(observedBuildKey({ execPath, resourcesPath }))
  const entrySourcePath = resolveEntrySourcePath(resourcesPath, observed?.entrySourcePath)
  return {
    appDir,
    execPath,
    resourcesPath,
    entrySourcePath,
    entryRelPath: toPosixRelative(appDir, entrySourcePath),
    windowsProcessTreeDir: join(resourcesPath, 'node_modules', '@vscode', 'windows-process-tree')
  }
}

function processTreeRelDir(sources: DaemonHostSources): string {
  return toPosixRelative(sources.appDir, sources.windowsProcessTreeDir)
}

function missingProcessTreeFiles(packageDir: string): boolean {
  return WINDOWS_PROCESS_TREE_REQUIRED.some(
    (relative) => !existsSync(join(packageDir, ...relative.split('/')))
  )
}

// Keep profile roots separate from legacy pruners; this profile cannot prove another profile's daemon dead.
const PROFILE_HOST_SUBDIR = 'daemon-host-profiles'

// Profiles share LOCALAPPDATA but have independent PID evidence, so each owns a separate mirror root.
function userDataProfileKey(userDataPath: string): string {
  const normalized = winPath.resolve(userDataPath).toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** This profile's mirror root; the only tree its prune may reclaim. */
export function getDaemonHostRootDir(): string {
  const userDataPath = getAppEnvironment().getPath('userData')
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    return join(
      localAppData,
      LOCAL_HOST_ROOT_NAME,
      PROFILE_HOST_SUBDIR,
      userDataProfileKey(userDataPath)
    )
  }
  return join(userDataPath, HOST_SUBDIR)
}

/** Require matching runtime and code inventory; app version alone cannot identify same-version builds. */
export function getRelocatedDaemonHost(): RelocatedDaemonHost | null {
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  const inventory = collectDaemonHostBuildInventory(sources)
  return findRelocatedDaemonHost(
    sources,
    currentBuildFingerprint(sources, inventory?.fingerprint ?? null)
  )
}

function findRelocatedDaemonHost(
  sources: DaemonHostSources,
  fingerprint: string | null
): RelocatedDaemonHost | null {
  if (fingerprint === null) {
    return null
  }
  const version = getAppEnvironment().getVersion()
  const versionRoot = join(getDaemonHostRootDir(), version)
  let builds
  try {
    builds = readdirSync(versionRoot, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = builds
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('build-'))
    .map((entry) => ({
      dest: join(versionRoot, entry.name),
      marker: readDaemonHostBuildMarker(join(versionRoot, entry.name))
    }))
    .sort((left, right) =>
      (right.marker?.completedAt ?? '').localeCompare(left.marker?.completedAt ?? '')
    )
  for (const { dest, marker } of candidates) {
    if (
      !marker ||
      !daemonHostFitsPathBudget(sources, dest) ||
      marker.version !== version ||
      !daemonHostBuildRuntimeMatches(marker, sources) ||
      marker.fingerprint !== fingerprint ||
      !daemonHostBuildInventoryMatches(dest, marker)
    ) {
      continue
    }
    const execPath = join(dest, marker.executableName)
    const entryPath = destPath(dest, marker.entryRelPath)
    if (
      !existsSync(execPath) ||
      !existsSync(entryPath) ||
      missingProcessTreeFiles(destPath(dest, processTreeRelDir(sources)))
    ) {
      continue
    }
    return { execPath, entryPath }
  }
  return null
}

/** Publish a complete immutable copy by rename; return null so callers can fall back on failure. */
export function materializeRelocatedDaemonHost(): RelocatedDaemonHost | null {
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  const inventory = collectDaemonHostBuildInventory(sources)
  const existing = findRelocatedDaemonHost(
    sources,
    currentBuildFingerprint(sources, inventory?.fingerprint ?? null)
  )
  if (existing) {
    return existing
  }
  // Reject incomplete sources before copying a runtime the mirror check would refuse anyway.
  if (!inventory || missingProcessTreeFiles(sources.windowsProcessTreeDir)) {
    return null
  }
  const version = getAppEnvironment().getVersion()
  const root = getDaemonHostRootDir()
  const versionRoot = join(root, version)
  const nonce = randomBytes(6).toString('hex')
  // Keep the unique name short for conpty; the marker carries the fingerprint.
  const dest = join(versionRoot, `build-${nonce}`)
  if (!daemonHostFitsPathBudget(sources, dest)) {
    console.warn(`[daemon] Not relocating the daemon host: ${dest} is too deep for conpty.dll`)
    return null
  }
  const staging = join(versionRoot, daemonHostStagingName(process.pid, nonce))
  try {
    mkdirSync(versionRoot, { recursive: true })
    executeManifest(buildDaemonHostManifest(sources), staging)
    writeDaemonHostBuildMarker(staging, version, inventory)
    // Publish a new immutable build; a same-version daemon may still load files from an older mirror.
    renameSync(staging, dest)
  } catch {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Best-effort staging cleanup.
    }
    return null
  }
  return findRelocatedDaemonHost(sources, inventory.fingerprint)
}

export type PinnedDaemonVersionsEvidence =
  | { status: 'complete'; versionLiveness: ReadonlyMap<string, ProcessLivenessVerdict> }
  | { status: 'unverifiable'; reason: string }

/** Pin versions conservatively by PID liveness; unreadable records veto pruning. */
export function collectPinnedDaemonVersions(runtimeDir: string): PinnedDaemonVersionsEvidence {
  const versionLiveness = new Map<string, ProcessLivenessVerdict>()
  let entries
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true })
  } catch {
    return { status: 'unverifiable', reason: 'the daemon runtime directory could not be read' }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^daemon-v\d+\.pid$/.test(entry.name)) {
      continue
    }
    let contents
    try {
      contents = readFileSync(join(runtimeDir, entry.name), 'utf8')
    } catch {
      // Read failures veto this prune; retry from the record on the next launch.
      return {
        status: 'unverifiable',
        reason: `the daemon pid file could not be read: ${entry.name}`
      }
    }
    const parsed = parseDaemonPidFile(contents)
    // Empty records can parse as PID 0 during publication; they must veto pruning instead of appearing legacy.
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return {
        status: 'unverifiable',
        reason: quarantineCorruptDaemonPidRecord(runtimeDir, entry.name, contents)
      }
    }
    // Pre-relocation daemons run from the install directory and pin no relocated host.
    if (parsed.appVersion === null) {
      continue
    }
    const verdict = inspectProcessLiveness(parsed.pid)
    versionLiveness.set(
      parsed.appVersion,
      mergeProcessLivenessVerdict(versionLiveness.get(parsed.appVersion), verdict)
    )
  }
  return { status: 'complete', versionLiveness }
}

export function pruneOldDaemonHosts(evidence: PinnedDaemonVersionsEvidence): void {
  if (!isPackagedElectronWin32()) {
    return
  }
  pruneDaemonHostStaging()
  if (evidence.status === 'unverifiable') {
    console.warn(`[daemon] Skipping daemon-host prune: ${evidence.reason}`)
    return
  }
  const version = getAppEnvironment().getVersion()
  const root = getDaemonHostRootDir()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // A published current-version build can belong to a daemon that has not written its pid yet.
    if (!entry.isDirectory() || entry.name === version) {
      continue
    }
    // Only a complete runtime-directory listing permits treating unrecorded versions as unowned.
    const verdict = evidence.versionLiveness.get(entry.name) ?? { status: 'exited' }
    reclaimUnownedDaemonHostDir(verdict, join(root, entry.name))
  }
}

/** Reclaim only copies whose writer positively exited, independently of daemon pid publication. */
export function pruneDaemonHostStaging(): void {
  if (isPackagedElectronWin32()) {
    reclaimAbandonedDaemonHostStaging(
      join(getDaemonHostRootDir(), getAppEnvironment().getVersion())
    )
  }
}
