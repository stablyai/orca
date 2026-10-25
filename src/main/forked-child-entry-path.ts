import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'

/** Plain-Node entries import this module; the build guard rejects literal Electron requires. */
export function resolveForkedChildEntryPath(
  entryFileName: string,
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  // Node mode bypasses asar integration; packaged entries must come from app.asar.unpacked.
  const usesAsarArchive = isPackaged && appPath.includes('app.asar')
  const basePath = usesAsarArchive ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const adjacentBuildEntry = join(basePath, entryFileName)
  // orcad and dev builds place children beside the entry; only asar layouts nest them under out/main.
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

export function getForkedChildEntryPath(entryFileName: string): string {
  if (hasAppEnvironment()) {
    const app = getAppEnvironment()
    return resolveForkedChildEntryPath(entryFileName, app.getAppPath(), app.isPackaged())
  }
  return resolveForkedChildEntryPathWithoutApp(entryFileName, process.cwd(), process.resourcesPath)
}
