import { existsSync } from 'node:fs'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'

type ElectronAppPath = { getAppPath(): string; isPackaged(): boolean }

// Why the port and not require('electron'): this module is reachable from plain-Node
// fork entries, where the literal text require("electron") fails the build guard even
// inside a try/catch. hasAppEnvironment() gives the same "no app root here" answer.
function loadElectronApp(): ElectronAppPath | null {
  return hasAppEnvironment() ? getAppEnvironment() : null
}

export function resolveWatcherProcessEntryPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  // Why: ELECTRON_RUN_AS_NODE bypasses Electron's asar integration, so the
  // packaged entry must be forked from app.asar.unpacked.
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const adjacentBuildEntry = join(basePath, 'parcel-watcher-process-entry.js')
  // Why: electron-vite's unpackaged appPath is already out/main. Appending
  // out/main again silently disables crash isolation in dev and E2E builds.
  if (!isPackaged && pathExists(adjacentBuildEntry)) {
    return adjacentBuildEntry
  }
  return join(basePath, 'out', 'main', 'parcel-watcher-process-entry.js')
}

export function resolveWatcherProcessEntryPathWithoutApp(
  cwd: string,
  resourcesPath: string | undefined,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  if (resourcesPath) {
    const packagedEntry = join(
      resourcesPath,
      'app.asar.unpacked',
      'out',
      'main',
      'parcel-watcher-process-entry.js'
    )
    // Why: ELECTRON_RUN_AS_NODE exposes resourcesPath but not electron.app.
    // Prefer the unpacked packaged entry without breaking dev Node fallbacks.
    if (pathExists(packagedEntry)) {
      return packagedEntry
    }
  }
  return resolveWatcherProcessEntryPath(cwd, false, pathExists)
}

export function getWatcherProcessEntryPath(): string {
  const app = loadElectronApp()
  if (app) {
    return resolveWatcherProcessEntryPath(app.getAppPath(), app.isPackaged())
  }
  return resolveWatcherProcessEntryPathWithoutApp(process.cwd(), process.resourcesPath)
}
