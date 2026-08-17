import { existsSync } from 'node:fs'
import { join } from 'node:path'

type ElectronAppPath = { getAppPath(): string; isPackaged: boolean }

function loadElectronApp(): ElectronAppPath | null {
  try {
    return require('electron').app ?? null
  } catch {
    return null
  }
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
    ? resolveAiVaultServiceEntryPath(app.getAppPath(), app.isPackaged)
    : resolveAiVaultServiceEntryPathWithoutApp(process.cwd(), process.resourcesPath)
}
