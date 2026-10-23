import { stat } from 'node:fs/promises'
import path from 'node:path'
import { localPathFromArgument } from './os-opened-path-argument'

export const MAX_PENDING_OS_OPENED_FOLDERS = 32

export function folderPathsFromArguments(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const paths = new Map<string, string>()
  for (const argument of argv) {
    if (!argument || argument.startsWith('-')) {
      continue
    }
    const localPath = localPathFromArgument(argument, platform)
    if (!localPath) {
      continue
    }
    const normalized = pathApi.normalize(localPath)
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized
    if (!paths.has(key)) {
      paths.set(key, normalized)
    }
  }
  return [...paths.values()]
}

export function folderArgumentsFromLaunch(argv: readonly string[], isPackaged: boolean): string[] {
  // Why: packaged argv starts with the executable; development also includes Electron's app entry.
  return argv.slice(isPackaged ? 1 : 2)
}

export class OsOpenedFolderState {
  private pending: string[] = []

  capture(argv: readonly string[], publish?: () => void): boolean {
    const paths = folderPathsFromArguments(argv)
    if (paths.length === 0) {
      return false
    }
    this.pending = folderPathsFromArguments([...this.pending, ...paths]).slice(
      0,
      MAX_PENDING_OS_OPENED_FOLDERS
    )
    publish?.()
    return true
  }

  consume(): string[] {
    const pending = this.pending
    this.pending = []
    return pending
  }

  restore(paths: readonly string[]): void {
    this.pending = folderPathsFromArguments([...paths, ...this.pending]).slice(
      0,
      MAX_PENDING_OS_OPENED_FOLDERS
    )
  }
}

export async function resolveOsOpenedFolders(paths: readonly string[]): Promise<string[]> {
  const folders: string[] = []
  for (const folder of folderPathsFromArguments(paths).slice(0, MAX_PENDING_OS_OPENED_FOLDERS)) {
    try {
      if ((await stat(folder)).isDirectory()) {
        folders.push(folder)
      }
    } catch {
      // A shell-selected folder may have disappeared before delivery.
    }
  }
  return folders
}
