import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'

/**
 * Where a forked child's built entry lives for one app root.
 *
 * Must not contain the literal text require('electron'): plain-Node fork entries
 * reach this module, and the build's plain-node-entry-guard rejects that text.
 */
export function resolveForkedChildEntryPath(
  entryFileName: string,
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  // Why: ELECTRON_RUN_AS_NODE bypasses Electron's asar integration, so the
  // packaged entry must be forked from app.asar.unpacked.
  const usesAsarArchive = isPackaged && appPath.includes('app.asar')
  const basePath = usesAsarArchive ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const adjacentBuildEntry = join(basePath, entryFileName)
  // Why asar and not isPackaged: orcad is a packaged non-Electron host whose app root holds
  // orcad.js and its children side by side; only the asar layout nests them under out/main.
  // electron-vite's unpackaged appPath is already out/main, so dev also lands here.
  if (!usesAsarArchive && pathExists(adjacentBuildEntry)) {
    return adjacentBuildEntry
  }
  return join(basePath, 'out', 'main', entryFileName)
}

/** For ELECTRON_RUN_AS_NODE, which exposes resourcesPath but no app root. */
export function resolveForkedChildEntryPathWithoutApp(
  entryFileName: string,
  cwd: string,
  resourcesPath: string | undefined,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  if (resourcesPath) {
    const packagedEntry = join(resourcesPath, 'app.asar.unpacked', 'out', 'main', entryFileName)
    if (pathExists(packagedEntry)) {
      return packagedEntry
    }
  }
  return resolveForkedChildEntryPath(entryFileName, cwd, false, pathExists)
}

/** The current process's path for a forked child's built entry. */
export function getForkedChildEntryPath(entryFileName: string): string {
  // Why the port: hasAppEnvironment() gives the same "no app root here" answer as electron.app.
  if (hasAppEnvironment()) {
    const app = getAppEnvironment()
    return resolveForkedChildEntryPath(entryFileName, app.getAppPath(), app.isPackaged())
  }
  return resolveForkedChildEntryPathWithoutApp(entryFileName, process.cwd(), process.resourcesPath)
}
