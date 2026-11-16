import type { Dirent } from 'node:fs'
import { lstat, opendir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { scanWorkspaceSpaceEntryTree } from '../../../shared/workspace-disk-space/workspace-space-entry-traversal'
import { MERGE_PENDING_SUFFIX, removeDirectoryLink } from '../../filesystem/merged-directory-link'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './setup/claude-profile-history'

const PROMPT_HISTORY = 'history.jsonl'
// Set-aside prompt history: pending drains (`-N` generations, `.offset` cursors) and replaced copies.
const PROMPT_HISTORY_ASIDE = [
  `${PROMPT_HISTORY}${MERGE_PENDING_SUFFIX}`,
  `${PROMPT_HISTORY}.orca-profile-conflict`
]
const HISTORY_DIRS: readonly string[] = CLAUDE_PROFILE_HISTORY_DIRS
const MEASURE_CONCURRENCY = 16

class RetainedHistoryUnreadableError extends Error {}

/**
 * History only this account holds: what never became a link into System default. Links, the
 * sign-in, `.claude.json` and settings are never retained.
 */
async function isRetainedClaudeHistory(home: string, entry: Dirent): Promise<boolean> {
  if (entry.isSymbolicLink()) {
    return false
  }
  if (
    entry.name.endsWith(MERGE_PENDING_SUFFIX) ||
    PROMPT_HISTORY_ASIDE.some((prefix) => entry.name.startsWith(prefix))
  ) {
    return true
  }
  if (HISTORY_DIRS.includes(entry.name)) {
    return entry.isDirectory()
  }
  if (entry.name === PROMPT_HISTORY && entry.isFile()) {
    // A Windows hardlink to the shared file is another name for System default's history.
    return (await lstat(join(home, entry.name))).nlink === 1
  }
  return false
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

/** Paths of the retained entries in an account folder (`claude-profiles/<id>`). */
async function listRetainedClaudeHistory(folder: string): Promise<string[]> {
  const home = join(folder, 'home')
  if (!(await isRealDirectory(folder)) || !(await isRealDirectory(home))) {
    return []
  }
  const retained: string[] = []
  for (const entry of await readdir(home, { withFileTypes: true })) {
    if (await isRetainedClaudeHistory(home, entry)) {
      retained.push(join(home, entry.name))
    }
  }
  return retained
}

/** Bytes of files in the retained entries; an unreadable entry fails the whole measurement. */
export async function measureRetainedClaudeHistory(folder: string): Promise<number> {
  let bytes = 0
  for (const path of await listRetainedClaudeHistory(folder)) {
    const scan = await scanWorkspaceSpaceEntryTree<Dirent>({
      rootPath: path,
      rootName: basename(path),
      concurrency: MEASURE_CONCURRENCY,
      entryName: (entry) => entry.name,
      joinPath: join,
      classifyEntry: async (entryPath) => {
        const stats = await lstat(entryPath)
        if (stats.isSymbolicLink()) {
          return { kind: 'symlink', sizeBytes: 0 }
        }
        return stats.isDirectory()
          ? { kind: 'directory', sizeBytes: 0 }
          : { kind: 'file', sizeBytes: stats.size }
      },
      readDirectory: (directory) => opendir(directory),
      checkCancelled: () => {},
      createCancellationError: () => new Error('Cancelled'),
      isCancellationError: () => false
    })
    if (scan.skippedEntryCount > 0) {
      throw new RetainedHistoryUnreadableError(`Could not read all of ${path}`)
    }
    bytes += scan.sizeBytes
  }
  return bytes
}

async function unlinkNestedLinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      await removeDirectoryLink(path)
    } else if (entry.isDirectory()) {
      await unlinkNestedLinks(path)
    }
  }
}

// Unlink links before recursive deletion can follow Windows junctions into shared history.
async function removeWithoutFollowingLinks(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  })
  if (!stats) {
    return
  }
  if (stats.isSymbolicLink()) {
    await removeDirectoryLink(path)
    return
  }
  if (stats.isDirectory()) {
    await unlinkNestedLinks(path)
  }
  await removeTree(path)
}

/** Delete an account folder; unless asked to delete them too, its retained conversations stay. */
export async function removeClaudeProfileFolder(
  folder: string,
  options: { deleteRetainedHistory: boolean }
): Promise<void> {
  if (!options.deleteRetainedHistory) {
    const home = join(folder, 'home')
    const retained = new Set(await listRetainedClaudeHistory(folder))
    if (retained.size > 0) {
      for (const entry of await readdir(home)) {
        if (!retained.has(join(home, entry))) {
          await removeWithoutFollowingLinks(join(home, entry))
        }
      }
      for (const entry of await readdir(folder)) {
        if (entry !== 'home') {
          await removeWithoutFollowingLinks(join(folder, entry))
        }
      }
    }
    // Read again: history a writer created meanwhile must not fall to the whole-folder removal.
    if ((await listRetainedClaudeHistory(folder)).length > 0) {
      return
    }
  }
  await removeWithoutFollowingLinks(folder)
}

const GUEST_KEPT_FUNCTION = [
  'kept() {',
  '  [ -L "$1" ] && return 1',
  '  case "${1##*/}" in',
  `    *${MERGE_PENDING_SUFFIX} | ${PROMPT_HISTORY_ASIDE.map((prefix) => `${prefix}*`).join(' | ')}) [ -e "$1" ] ;;`,
  `    ${HISTORY_DIRS.join(' | ')}) [ -d "$1" ] ;;`,
  `    ${PROMPT_HISTORY}) [ -f "$1" ] && [ "$(stat -c %h -- "$1")" = 1 ] ;;`,
  '    *) return 1 ;;',
  '  esac',
  '}',
  // A linked folder or home must never be walked: its entries belong to the link target.
  'scannable() { [ -d "$folder" ] && [ ! -L "$folder" ] && [ -d "$home" ] && [ ! -L "$home" ]; }',
  'entries() { for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
  '  if [ -e "$entry" ] || [ -L "$entry" ]; then printf "%s\\0" "$entry"; fi',
  'done; }'
]

const GUEST_PREAMBLE = [
  'set -u -o pipefail',
  'folder=$1',
  'home=$folder/home',
  ...GUEST_KEPT_FUNCTION
]

/** Guest twin of `removeClaudeProfileFolder`; GNU rm removes a link itself, never its target. */
export const GUEST_REMOVE_KEEPING_HISTORY_SCRIPT = [
  ...GUEST_PREAMBLE,
  'any_kept() { scannable && while IFS= read -r -d "" entry; do kept "$entry" && return 0; done < <(entries "$home"); return 1; }',
  'if [ "${2:-}" != delete ] && any_kept; then',
  '  while IFS= read -r -d "" entry; do kept "$entry" || rm -rf -- "$entry"; done < <(entries "$home")',
  '  while IFS= read -r -d "" entry; do [ "$entry" = "$home" ] || rm -rf -- "$entry"; done < <(entries "$folder")',
  '  any_kept && exit 0',
  'fi',
  'rm -rf -- "$folder"'
].join('\n')

/** Guest twin of `measureRetainedClaudeHistory`: prints the byte total, or fails. */
export const GUEST_MEASURE_HISTORY_SCRIPT = [
  ...GUEST_PREAMBLE,
  'total=0',
  'if scannable; then',
  '  while IFS= read -r -d "" entry; do',
  '    kept "$entry" || continue',
  `    size=$(find "$entry" -type f -printf '%s\\n' | awk '{ s += $1 } END { printf "%.0f", s }') || exit 1`,
  '    total=$((total + size))',
  '  done < <(entries "$home")',
  'fi',
  'printf "%s\\n" "$total"'
].join('\n')
