import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ensureRelocatedRuntime } from '../pty/install-dir-runtime-relocation'

/**
 * Relocates the Node host that runs the detached terminal daemon out of the
 * app install directory into userData.
 *
 * Why: the daemon is `fork()`ed as plain Node via ELECTRON_RUN_AS_NODE, so its
 * process image is the install-dir Orca.exe. The NSIS update installer
 * force-closes every process whose image path is under the install directory
 * before replacing files, which kills the daemon — and every live terminal it
 * owns — mid-update. Running the daemon from a version-keyed node.exe staged in
 * userData takes its image out of the installer's kill zone so it survives.
 *
 * Fail-open: if no bundled node.exe is present (dev, or a build that predates
 * shipping it), relocation no-ops and the caller keeps forking the install-dir
 * Orca.exe host — the pre-relocation behavior, with zero regression.
 */
const RELOCATED_DAEMON_HOST_EXE = 'node.exe'

let relocatedDaemonHostExecPath: string | null = null
let installed = false

/**
 * The bundled daemon-host dir under app resources, or null when no node.exe is
 * shipped there. Kept separate from install so the resources path is testable.
 */
export function resolveDaemonHostSourceDir(resourcesPath: string): string | null {
  const dir = join(resourcesPath, 'daemon-host')
  return existsSync(join(dir, RELOCATED_DAEMON_HOST_EXE)) ? dir : null
}

/**
 * Copies the bundled daemon-host node.exe into a version-keyed userData dir
 * (once) and records its path for the daemon fork. Safe to call more than once;
 * only the first call does work.
 */
export function installRelocatedDaemonHost(): void {
  if (installed) {
    return
  }
  installed = true
  if (process.platform !== 'win32') {
    return
  }
  // The install-dir kill zone only exists for packaged installs; a dev override
  // lets the relocation path be exercised without a full NSIS build.
  if (!app.isPackaged && process.env.ORCA_FORCE_DAEMON_HOST_RELOCATION !== '1') {
    return
  }
  // Why: fail-open contract — this must never throw. resourcesPath is unset
  // outside a real Electron process (tests, node-hosted tooling).
  if (typeof process.resourcesPath !== 'string') {
    return
  }
  const sourceDir = resolveDaemonHostSourceDir(process.resourcesPath)
  if (!sourceDir) {
    return
  }
  const userData = app.getPath('userData')
  const destDir = ensureRelocatedRuntime({
    sourceDir,
    destRoot: join(userData, 'daemon-host'),
    version: app.getVersion(),
    // Same runtimeDir daemon-init writes daemon-v<N>.pid into, so a surviving
    // daemon's host dir is pinned by its recorded appVersion and never reclaimed
    // while it runs.
    daemonRuntimeDir: join(userData, 'daemon')
  })
  if (destDir) {
    relocatedDaemonHostExecPath = join(destDir, RELOCATED_DAEMON_HOST_EXE)
  }
}

/**
 * The relocated node.exe to fork the daemon from, or null to fall back to the
 * install-dir Electron host (ELECTRON_RUN_AS_NODE).
 */
export function getRelocatedDaemonHostExecPath(): string | null {
  return relocatedDaemonHostExecPath
}
