import { basename, isAbsolute, relative, sep } from 'node:path'
import { DEV_FOLDER_SKIPPED_ROOT_ENTRIES } from './plugin-content-hash'

// Why these: the dev tree hash and plugin serving never read them, so their churn is not an edit.
const IGNORED_DEV_ROOT_ENTRIES: readonly string[] = ['.git', ...DEV_FOLDER_SKIPPED_ROOT_ENTRIES]
const OS_JUNK_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Native-side exclusions for a dev root's recursive subscription; plain names match only the root. */
export const PLUGIN_DEV_WATCH_IGNORE: readonly string[] = IGNORED_DEV_ROOT_ENTRIES

export function isIgnoredPluginDevPath(root: string, path: string): boolean {
  if (OS_JUNK_FILE_NAMES.has(basename(path))) {
    return true
  }
  const fromRoot = relative(root, path)
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    return false
  }
  return IGNORED_DEV_ROOT_ENTRIES.includes(fromRoot.split(sep)[0] ?? '')
}
