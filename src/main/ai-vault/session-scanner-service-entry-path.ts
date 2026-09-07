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

export function resolveAiVaultServiceEntryPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const adjacentEntry = join(basePath, 'session-scanner-service-entry.js')
  if (!isPackaged && pathExists(adjacentEntry)) {
    return adjacentEntry
  }
  return join(basePath, 'out', 'main', 'session-scanner-service-entry.js')
}

export function resolveAiVaultServiceEntryPathWithoutApp(
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
      'session-scanner-service-entry.js'
    )
    if (pathExists(packagedEntry)) {
      return packagedEntry
    }
  }
  return resolveAiVaultServiceEntryPath(cwd, false, pathExists)
}

export function getAiVaultServiceEntryPath(): string {
  const app = loadElectronApp()
  return app
    ? resolveAiVaultServiceEntryPath(app.getAppPath(), app.isPackaged())
    : resolveAiVaultServiceEntryPathWithoutApp(process.cwd(), process.resourcesPath)
}
