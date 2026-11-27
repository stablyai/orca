import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, win32 as winPath } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { renameWithWindowsRetry } from '../../../filesystem/windows-rename-retry'
import { currentBuildFingerprint, observedEntrySourcePath } from './daemon-host-observed-builds'
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
  collectDaemonHostBuildInventoryAsync,
  daemonHostBuildInventoryMatches,
  daemonHostBuildInventoryMatchesAsync,
  daemonHostBuildRuntimeMatches,
  readDaemonHostBuildMarker,
  writeDaemonHostBuildMarker,
  type DaemonHostBuildMarker
} from './daemon-host-build-inventory'
import {
  daemonHostStagingName,
  reclaimAbandonedDaemonHostStaging,
  reclaimUnownedDaemonHostDir
} from './daemon-host-reclaim'
import type { PinnedDaemonVersionsEvidence } from './daemon-host-pinned-versions'

// Copy the Electron runtime outside NSIS's install-directory kill zone; failures fall back to the install runtime.

export type RelocatedDaemonHost = {
  execPath: string
  entryPath: string
}

const HOST_SUBDIR = 'daemon-host'
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
  const entrySourcePath = resolveEntrySourcePath(
    resourcesPath,
    observedEntrySourcePath({ execPath, resourcesPath })
  )
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

type RelocatedBuildCandidate = RelocatedDaemonHost & {
  dest: string
  marker: DaemonHostBuildMarker
}

// Newest-first builds whose marker matches this runtime; callers still verify copied bytes.
function relocatedBuildCandidates(
  sources: DaemonHostSources,
  fingerprint: string | null
): RelocatedBuildCandidate[] {
  if (fingerprint === null) {
    return []
  }
  const version = getAppEnvironment().getVersion()
  const versionRoot = join(getDaemonHostRootDir(), version)
  let builds
  try {
    builds = readdirSync(versionRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return builds
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('build-'))
    .map((entry) => ({
      dest: join(versionRoot, entry.name),
      marker: readDaemonHostBuildMarker(join(versionRoot, entry.name))
    }))
    .sort((left, right) =>
      (right.marker?.completedAt ?? '').localeCompare(left.marker?.completedAt ?? '')
    )
    .flatMap(({ dest, marker }) =>
      marker &&
      daemonHostFitsPathBudget(sources, dest) &&
      marker.version === version &&
      daemonHostBuildRuntimeMatches(marker, sources) &&
      marker.fingerprint === fingerprint
        ? [
            {
              dest,
              marker,
              execPath: join(dest, marker.executableName),
              entryPath: destPath(dest, marker.entryRelPath)
            }
          ]
        : []
    )
}

function candidateFilesPresent(
  sources: DaemonHostSources,
  candidate: RelocatedBuildCandidate
): boolean {
  return (
    existsSync(candidate.execPath) &&
    existsSync(candidate.entryPath) &&
    !missingProcessTreeFiles(destPath(candidate.dest, processTreeRelDir(sources)))
  )
}

function findRelocatedDaemonHost(
  sources: DaemonHostSources,
  fingerprint: string | null
): RelocatedDaemonHost | null {
  for (const candidate of relocatedBuildCandidates(sources, fingerprint)) {
    if (
      daemonHostBuildInventoryMatches(candidate.dest, candidate.marker) &&
      candidateFilesPresent(sources, candidate)
    ) {
      return { execPath: candidate.execPath, entryPath: candidate.entryPath }
    }
  }
  return null
}

async function findRelocatedDaemonHostAsync(
  sources: DaemonHostSources,
  fingerprint: string | null
): Promise<RelocatedDaemonHost | null> {
  for (const candidate of relocatedBuildCandidates(sources, fingerprint)) {
    if (
      (await daemonHostBuildInventoryMatchesAsync(candidate.dest, candidate.marker)) &&
      candidateFilesPresent(sources, candidate)
    ) {
      return { execPath: candidate.execPath, entryPath: candidate.entryPath }
    }
  }
  return null
}

let inFlightMaterialization: Promise<RelocatedDaemonHost | null> | null = null

/** Publish a complete immutable copy by rename off the event loop; null lets callers fall back. */
export function materializeRelocatedDaemonHost(): Promise<RelocatedDaemonHost | null> {
  // Concurrent launches share one copy instead of racing two staging trees.
  inFlightMaterialization ??= materializeOnce().finally(() => {
    inFlightMaterialization = null
  })
  return inFlightMaterialization
}

async function materializeOnce(): Promise<RelocatedDaemonHost | null> {
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  const inventory = await collectDaemonHostBuildInventoryAsync(sources)
  const existing = await findRelocatedDaemonHostAsync(
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
    await mkdir(versionRoot, { recursive: true })
    await executeManifest(
      buildDaemonHostManifest(sources),
      staging,
      new Map(inventory.files.map((file) => [file.path, file.sha256]))
    )
    await writeDaemonHostBuildMarker(staging, version, inventory)
    // Publish a new immutable build (a live daemon may use an older one); retry Defender's brief holds.
    await renameWithWindowsRetry(staging, dest)
  } catch {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      // Best-effort staging cleanup; a later launch reclaims it once this pid exits.
    })
    return null
  }
  return findRelocatedDaemonHostAsync(sources, inventory.fingerprint)
}

export async function pruneOldDaemonHosts(evidence: PinnedDaemonVersionsEvidence): Promise<void> {
  if (!isPackagedElectronWin32()) {
    return
  }
  await pruneDaemonHostStaging()
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
    await reclaimUnownedDaemonHostDir(verdict, join(root, entry.name))
  }
}

/** Reclaim only copies whose writer positively exited, independently of daemon pid publication. */
export async function pruneDaemonHostStaging(): Promise<void> {
  if (isPackagedElectronWin32()) {
    await reclaimAbandonedDaemonHostStaging(
      join(getDaemonHostRootDir(), getAppEnvironment().getVersion())
    )
  }
}
