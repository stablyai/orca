import { existsSync } from 'node:fs'
import {
  getForkedChildEntryPath,
  resolveForkedChildEntryPath,
  resolveForkedChildEntryPathWithoutApp
} from '../forked-child-entry-path'

const WATCHER_ENTRY_FILENAME = 'parcel-watcher-process-entry.js'

export function watcherProcessEntryExists(entryPath: string): boolean {
  if (existsSync(entryPath)) {
    return true
  }
  console.error(`[parcel-watcher-process] entry not found at ${entryPath}; refusing fail-open`)
  return false
}

export function resolveWatcherProcessEntryPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  return resolveForkedChildEntryPath(WATCHER_ENTRY_FILENAME, appPath, isPackaged, pathExists)
}

export function resolveWatcherProcessEntryPathWithoutApp(
  cwd: string,
  resourcesPath: string | undefined,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  return resolveForkedChildEntryPathWithoutApp(
    WATCHER_ENTRY_FILENAME,
    cwd,
    resourcesPath,
    pathExists
  )
}

export function getWatcherProcessEntryPath(): string {
  return getForkedChildEntryPath(WATCHER_ENTRY_FILENAME)
}
