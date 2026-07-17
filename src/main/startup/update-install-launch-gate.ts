import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Why: Squirrel.Mac installs by swapping the bundle AFTER the app exits, and
// Electron's fork aborts the whole install ("App Still Running Error") when
// another instance of the bundle shows up mid-install. A user who reopens
// Orca in the seconds between "windows closed" and "updated app relaunched"
// becomes that instance: the update is silently discarded and they come back
// on the old version. The quitting app drops a handoff marker; a same-version
// launch that finds the marker fresh while this bundle's ShipIt installer is
// still alive exits instead — ShipIt then finishes and relaunches the updated
// app itself, so the user's click still ends with Orca open.
export const UPDATE_INSTALL_HANDOFF_MARKER_DIRECTORY = 'orca-update-install-handoffs'
// Why: quitAndInstall writes the marker immediately before spawning ShipIt.
// During this bounded arming window, the marker is authoritative because the
// installer may not be visible in the process table yet.
export const UPDATE_INSTALL_HANDOFF_ARMING_MS = 5_000
// Why: the handoff normally resolves in seconds; the ceiling only bounds how
// long a crashed install could keep gating launches. The live-ShipIt check is
// the real gate, so a stale marker never locks the app out.
export const UPDATE_INSTALL_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000

const PROCESS_LIST_TIMEOUT_MS = 2_000
const PROCESS_LIST_MAX_BYTES = 16 * 1024 * 1024

export type UpdateInstallHandoffMarker = {
  appVersion: string
  createdAtMs: number
}

function removeFileBestEffort(filePath: string): void {
  try {
    rmSync(filePath, { force: true })
  } catch {
    // Marker cleanup must never prevent an install or a normal app launch.
  }
}

function bundleRootForExecutable(executablePath: string): string {
  // Why: these paths always describe a macOS bundle, even in cross-platform
  // unit tests, so host-native separators would change the identity.
  return path.posix.resolve(executablePath, '..', '..', '..')
}

export function getUpdateInstallHandoffMarkerPath(
  appDataPath: string,
  executablePath: string
): string {
  // Why: appData is shared by isolated Orca profiles, while the executable
  // hash keeps side-by-side app bundles from gating each other's launches.
  const bundleId = createHash('sha256')
    .update(bundleRootForExecutable(executablePath))
    .digest('hex')
    .slice(0, 16)
  return path.join(appDataPath, UPDATE_INSTALL_HANDOFF_MARKER_DIRECTORY, `${bundleId}.json`)
}

/** Written by the updater immediately before the native install handoff. */
export function writeUpdateInstallHandoffMarker(
  appDataPath: string,
  executablePath: string,
  appVersion: string,
  now = Date.now()
): void {
  const finalPath = getUpdateInstallHandoffMarkerPath(appDataPath, executablePath)
  const temporaryPath = `${finalPath}.${process.pid}.${now}.tmp`
  try {
    const marker: UpdateInstallHandoffMarker = { appVersion, createdAtMs: now }
    mkdirSync(path.dirname(finalPath), { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(marker))
    // Why: a direct overwrite can expose partial JSON to the launch racing
    // this write. Same-directory rename publishes the complete marker at once.
    renameSync(temporaryPath, finalPath)
  } catch {
    // Why: the marker only powers the relaunch-race guard; failing to write
    // it must never block the install itself.
  } finally {
    removeFileBestEffort(temporaryPath)
  }
}

export function clearUpdateInstallHandoffMarker(appDataPath: string, executablePath: string): void {
  removeFileBestEffort(getUpdateInstallHandoffMarkerPath(appDataPath, executablePath))
}

function readUpdateInstallHandoffMarker(
  appDataPath: string,
  executablePath: string
): UpdateInstallHandoffMarker | null {
  const filePath = getUpdateInstallHandoffMarkerPath(appDataPath, executablePath)
  try {
    if (!existsSync(filePath)) {
      return null
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (
      typeof parsed?.appVersion !== 'string' ||
      typeof parsed?.createdAtMs !== 'number' ||
      !Number.isFinite(parsed.createdAtMs)
    ) {
      removeFileBestEffort(filePath)
      return null
    }
    return { appVersion: parsed.appVersion, createdAtMs: parsed.createdAtMs }
  } catch {
    // Why: a corrupt marker cannot ever become actionable; removing it avoids
    // repeated startup reads while preserving the fail-open contract.
    removeFileBestEffort(filePath)
    return null
  }
}

function readProcessCommandList(): string {
  // Why: ShipIt can run as root when the app bundle is not user-writable.
  // Use the system binary so a shell-hydrated PATH cannot change detection.
  return execFileSync('/bin/ps', ['-axo', 'command='], {
    encoding: 'utf8',
    timeout: PROCESS_LIST_TIMEOUT_MS,
    maxBuffer: PROCESS_LIST_MAX_BYTES
  })
}

/** True when this bundle's Squirrel ShipIt installer is still running. The
 * bundle root comes from the executable path, so only an installer working on
 * this exact install is considered. */
export function isBundleShipItRunning(executablePath: string, processCommandList: string): boolean {
  // /Applications/Orca.app/Contents/MacOS/Orca → /Applications/Orca.app
  const bundleRoot = bundleRootForExecutable(executablePath)
  const shipItPath = path.posix.join(
    bundleRoot,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Resources',
    'ShipIt'
  )
  // Why: anchor on argv[0]. A shell or grep merely mentioning the ShipIt path
  // in its arguments must not read as a live installer.
  return processCommandList.split('\n').some((line) => {
    const command = line.trimStart()
    return command === shipItPath || command.startsWith(`${shipItPath} `)
  })
}

export type UpdateInstallLaunchGateDeps = {
  platform?: NodeJS.Platform
  executablePath?: string
  now?: number
  readProcessList?: () => string
}

/**
 * Decide whether this launch should exit to let an in-flight update install
 * finish. Sync by design — it must resolve before any startup side effects,
 * and the process-table read only happens on the rare fresh-marker path.
 * An unreadable marker fails open; after the bounded arming phase, an
 * unreadable process table does too.
 */
export function shouldDeferLaunchForUpdateInstall(options: {
  isPackaged: boolean
  appDataPath: string
  appVersion: string
  deps?: UpdateInstallLaunchGateDeps
}): boolean {
  const platform = options.deps?.platform ?? process.platform
  if (platform !== 'darwin' || !options.isPackaged) {
    return false
  }
  const executablePath = options.deps?.executablePath ?? process.execPath
  const marker = readUpdateInstallHandoffMarker(options.appDataPath, executablePath)
  if (!marker) {
    return false
  }
  // A different running version means the install already happened (or was
  // rolled elsewhere) — this launch is the post-update relaunch.
  if (marker.appVersion !== options.appVersion) {
    clearUpdateInstallHandoffMarker(options.appDataPath, executablePath)
    return false
  }
  const now = options.deps?.now ?? Date.now()
  const markerAgeMs = now - marker.createdAtMs
  if (markerAgeMs < 0 || markerAgeMs > UPDATE_INSTALL_HANDOFF_MAX_AGE_MS) {
    clearUpdateInstallHandoffMarker(options.appDataPath, executablePath)
    return false
  }
  if (markerAgeMs <= UPDATE_INSTALL_HANDOFF_ARMING_MS) {
    return true
  }
  let processList: string
  try {
    processList = (options.deps?.readProcessList ?? readProcessCommandList)()
  } catch {
    clearUpdateInstallHandoffMarker(options.appDataPath, executablePath)
    return false
  }
  if (isBundleShipItRunning(executablePath, processList)) {
    return true
  }
  // Same version and no installer left: the install died (aborted/failed).
  // Clear the marker so this and future launches proceed normally.
  clearUpdateInstallHandoffMarker(options.appDataPath, executablePath)
  return false
}
