import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join, win32 as winPath } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { renameWithWindowsRetry } from '../../../filesystem/windows-rename-retry'
import { currentBuildFingerprint, observedEntrySourcePath } from './daemon-host-observed-builds'
import { removeDaemonHostTree } from './daemon-host-tree-walk'
import {
  buildDaemonHostManifest,
  daemonHostFitsPathBudget,
  daemonHostProcessPackageDir,
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
  inventoryFromFiles,
  readDaemonHostBuildMarker,
  writeDaemonHostBuildMarker,
  type DaemonHostBuildInventory,
  type DaemonHostBuildMarker
} from './daemon-host-build-inventory'
import {
  daemonHostCodeMatcher,
  inventoryRootsAsync,
  processHostExportsPresentAsync
} from './daemon-host-inventory-roots'
import { daemonHostStagingName } from './daemon-host-reclaim'

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
export function isPackagedElectronWin32(): boolean {
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

// Any published build means the source fingerprint is needed to pick or reject it.
async function hasBuildCandidates(): Promise<boolean> {
  const versionRoot = join(getDaemonHostRootDir(), getAppEnvironment().getVersion())
  const names = await readdir(versionRoot).catch(() => [])
  return names.some((name) => name.startsWith('build-'))
}

async function materializeOnce(): Promise<RelocatedDaemonHost | null> {
  const sources = collectDaemonHostSources()
  if (!sources) {
    return null
  }
  // A torn or unreadable source manifest falls back like a missing inventory did.
  const roots = await inventoryRootsAsync(sources).catch(() => null)
  // With no build to compare against, skip hashing sources up front; the copy fingerprints its own bytes.
  if (roots && !(await hasBuildCandidates())) {
    return publishRelocatedHost(sources, null)
  }
  const inventory = roots ? await collectDaemonHostBuildInventoryAsync(sources, roots) : null
  const existing = await findRelocatedDaemonHostAsync(
    sources,
    currentBuildFingerprint(sources, inventory?.fingerprint ?? null)
  )
  if (existing || !roots || !inventory) {
    return existing
  }
  return publishRelocatedHost(sources, inventory)
}

async function publishRelocatedHost(
  sources: DaemonHostSources,
  inventory: DaemonHostBuildInventory | null
): Promise<RelocatedDaemonHost | null> {
  // Reject incomplete sources before copying a runtime the mirror check would refuse anyway.
  if (missingProcessTreeFiles(sources.windowsProcessTreeDir)) {
    return null
  }
  const version = getAppEnvironment().getVersion()
  const versionRoot = join(getDaemonHostRootDir(), version)
  const nonce = randomBytes(6).toString('hex')
  // Keep the unique name short for conpty; the marker carries the fingerprint.
  const dest = join(versionRoot, `build-${nonce}`)
  if (!daemonHostFitsPathBudget(sources, dest)) {
    console.warn(`[daemon] Not relocating the daemon host: ${dest} is too deep for conpty.dll`)
    return null
  }
  const staging = join(versionRoot, daemonHostStagingName(process.pid, nonce))
  let published: DaemonHostBuildInventory
  try {
    await mkdir(versionRoot, { recursive: true })
    const hashes = await executeManifest(buildDaemonHostManifest(sources), staging, {
      isCode: daemonHostCodeMatcher(sources),
      ...(inventory
        ? { expected: new Map(inventory.files.map((file) => [file.path, file.sha256])) }
        : {})
    })
    published =
      inventory ??
      inventoryFromFiles(
        sources,
        [...hashes].map(([path, sha256]) => ({ path, sha256 }))
      )
    // A cold copy has no expected inventory, so confirm the exports root validation relied on were copied.
    const stagedProcessHost = destPath(
      staging,
      toPosixRelative(sources.appDir, daemonHostProcessPackageDir(sources))
    )
    if (!(await processHostExportsPresentAsync(stagedProcessHost))) {
      throw new Error('daemon-host relocation: copy lacks a process-host export')
    }
    await writeDaemonHostBuildMarker(staging, version, published)
    // Publish a new immutable build (a live daemon may use an older one); retry Defender's brief holds.
    await renameWithWindowsRetry(staging, dest)
  } catch {
    await removeDaemonHostTree(staging).catch(() => {
      // Best-effort staging cleanup; a later launch reclaims it once this pid exits.
    })
    return null
  }
  currentBuildFingerprint(sources, published.fingerprint)
  return findRelocatedDaemonHostAsync(sources, published.fingerprint)
}
