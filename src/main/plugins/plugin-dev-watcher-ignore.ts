import { basename, isAbsolute, relative, sep } from 'node:path'
import {
  buildParcelWatcherIgnoreOptions,
  type ParcelWatcherIgnoreOptions
} from '../ipc/filesystem/watchers/filesystem-watcher-ignore'
import { DEV_FOLDER_SKIPPED_DIRECTORIES } from './plugin-content-hash'

// Why these: the dev tree hash and plugin serving never read them, so their churn is not an edit.
const IGNORED_DEV_DIRECTORIES: readonly string[] = [...DEV_FOLDER_SKIPPED_DIRECTORIES]
const OS_JUNK_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Native-side exclusions for a dev root's recursive subscription, at any depth. */
export function pluginDevWatchIgnoreOptions(): ParcelWatcherIgnoreOptions {
  return buildParcelWatcherIgnoreOptions(IGNORED_DEV_DIRECTORIES)
}

export function isIgnoredPluginDevPath(root: string, path: string): boolean {
  if (OS_JUNK_FILE_NAMES.has(basename(path))) {
    return true
  }
  const fromRoot = relative(root, path)
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    return false
  }
  return fromRoot.split(sep).some((segment) => IGNORED_DEV_DIRECTORIES.includes(segment))
}
