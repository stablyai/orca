import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, win32 as winPath } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  buildDaemonHostManifest,
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

/**
 * Relocate the terminal daemon's process image out of the app install dir into LOCAL userData so it
 * survives Windows auto-updates: the NSIS installer deletes the old install and force-kills every process
 * imaged under it, which would otherwise kill the daemon and its live terminals. The relocated exe is a
 * run-as-node Orca.exe copy (not node.exe) so there's no console flash and asar still resolves. Fail-open:
 * any failure returns null and the caller forks the install-dir host (pre-relocation behavior).
 *
 * What escapes the updater is the PATH, not the file name: electron-builder's kill sweep selects
 * processes whose image path sits under $INSTDIR. See docs/reference/windows-daemon-host-relocation.md
 * for the survival contract and why the exe is copied verbatim rather than renamed.
 */

export type RelocatedDaemonHost = {
  /** The relocated host exe to fork the daemon from (run as node). */
  execPath: string
  /** The copied daemon-entry.js, mirrored under the relocated resources tree. */
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
  // Once this process observed its build, an updater removing source files cannot select another same-version build.
  const observed = observedBuilds.get(key)
  return observed?.entrySourcePath === sources.entrySourcePath ? observed.fingerprint : null
}

// LOCAL appData (not roaming) so OneDrive/roaming never syncs this ~260MB runtime. Shared with NSIS uninstall (config/nsis/orca-installer-hooks.nsh) — keep in sync.
const LOCAL_HOST_ROOT_NAME = 'Orca'

// Mirror getDaemonEntryPath()'s resolution order so the copied entry is the exact file the in-dir fork would run.
function resolveEntrySourcePath(resourcesPath: string, observedEntryPath?: string): string {
  const unpackedRoot = join(resourcesPath, 'app.asar.unpacked')
  const direct = join(unpackedRoot, 'daemon-entry.js')
  if (existsSync(direct)) {
    return direct
  }
  const nested = join(unpackedRoot, 'out', 'main', 'daemon-entry.js')
  // Preserve the observed layout only when neither live entry survives the updater.
  return existsSync(nested) ? nested : (observedEntryPath ?? nested)
}

/**
 * Whether this process is a packaged ELECTRON app on win32 — the only shape relocation
 * addresses, because what it escapes is the NSIS updater's kill zone.
 *
 * Why asar and not isPackaged alone: orcad answers isPackaged() true (it is a shipped build,
 * not a dev checkout) while having no asar, no resourcesPath and no NSIS installer. Asking
 * whether the app root is an asar archive is the same honesty fix the watcher path uses, and
 * it keeps a Node host from staging a copy of an Electron tree it does not have.
 */
function isPackagedElectronWin32(): boolean {
  const environment = getAppEnvironment()
  return (
    process.platform === 'win32' &&
    environment.isPackaged() &&
    environment.getAppPath().includes('app.asar')
  )
}

// Relocation inputs from the live packaged process, or null when it doesn't apply (non-win32, dev, or missing resourcesPath).
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

/** True when any file require() needs is absent from a copy of the package. */
function missingProcessTreeFiles(packageDir: string): boolean {
  return WINDOWS_PROCESS_TREE_REQUIRED.some(
    (relative) => !existsSync(join(packageDir, ...relative.split('/')))
  )
}

// Sibling of the legacy shared HOST_SUBDIR, whose older pruners delete every unpinned child dir.
// That legacy root is never reclaimed here: profile-scoped pid evidence can't prove another
// profile's daemon gone, and new code never writes there, so its cost is a finite one-time
// copy (~260MB) per pre-upgrade mirror until a genuine uninstall removes it.
const PROFILE_HOST_SUBDIR = 'daemon-host-profiles'

// Profiles (--user-data-dir, E2E) share LOCALAPPDATA but not pid records, so one profile's
// listing cannot prove another's mirror unowned; each profile owns only its own root.
function userDataProfileKey(userDataPath: string): string {
  const normalized = winPath.resolve(userDataPath).toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** This profile's mirror root; the only tree its prune may reclaim. */
export function getDaemonHostRootDir(): string {
  const userDataPath = getAppEnvironment().getPath('userData')
  // Prefer LOCAL appData (see LOCAL_HOST_ROOT_NAME); fall back to userData only if LOCALAPPDATA is unset.
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

/**
 * The relocated host for the current version, or null. Valid only when the marker matches this version
 * AND the exe + entry exist, so a partial or stale copy never reports ready.
 */
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

/**
 * Materialize the current version's daemon host, returning its fork paths or null (fail-open). Idempotent
 * via marker; stages into a temp sibling and publishes by atomic rename, so a crash mid-copy never leaves a half-populated dest.
 */
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
  // Checked against the source before copying: the mirror check below would refuse
  // the result anyway, and re-copying ~260MB on every launch to reach that verdict
  // is the loop this shares its list with the copy plan to prevent.
  if (!inventory || missingProcessTreeFiles(sources.windowsProcessTreeDir)) {
    return null
  }
  const version = getAppEnvironment().getVersion()
  const root = getDaemonHostRootDir()
  const versionRoot = join(root, version)
  const nonce = randomBytes(6).toString('hex')
  const dest = join(versionRoot, `build-${inventory.fingerprint}-${nonce}`)
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

/**
 * App versions still pinned by a live daemon (from daemon-v<N>.pid files under `runtimeDir`), whose
 * host dir must not be reclaimed while alive. On win32 start-time can't verify, so a matching pid pins conservatively.
 */
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
      // Read failures (AV lock, vanished file) are transient; the veto re-evaluates next launch.
      return {
        status: 'unverifiable',
        reason: `the daemon pid file could not be read: ${entry.name}`
      }
    }
    const parsed = parseDaemonPidFile(contents)
    // Why not just `!parsed`: the parser's legacy bare-integer fallback coerces an empty or
    // whitespace-only record to pid 0 (Number('') === 0), which is the exact shape a concurrent
    // read sees while a live daemon publishes its record — writeFileSync 'wx' creates the file
    // before writing it. Such a record would otherwise pass as a valid pre-relocation daemon,
    // skip on appVersion === null, and leave its version unpinned, so the prune below would
    // reclaim a running daemon's host image. A pid that is not a positive integer names no
    // process — process.kill(0, 0) probes the caller's own process group, never a daemon — so
    // it is not liveness evidence and must veto rather than be skipped.
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return {
        status: 'unverifiable',
        reason: quarantineCorruptDaemonPidRecord(runtimeDir, entry.name, contents)
      }
    }
    // appVersion null => pre-relocation daemon forked from the install dir; pins no host dir here.
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

/**
 * Reclaim daemon-host/<ver> dirs that are neither the current version nor pinned by a live daemon.
 * Best-effort — never throws; a locked/staging dir is retried on a future launch.
 */
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
    // A complete runtime-dir listing with no pid record for this version proves it is unowned.
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
