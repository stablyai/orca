import type { Dirent } from 'node:fs'
import { lstat, opendir, readdir, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { scanWorkspaceSpaceEntryTree } from '../../../shared/workspace-disk-space/workspace-space-entry-traversal'
import { MERGE_PENDING_SUFFIX, removeDirectoryLink } from '../../filesystem/merged-directory-link'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './setup/claude-profile-history'
import { fileIdentity } from './setup/claude-profile-prompt-history'

const PROMPT_HISTORY = 'history.jsonl'
// Set-aside prompt history: pending drains (`-N` generations, `.offset` cursors) and replaced copies.
const PROMPT_HISTORY_ASIDE = [
  `${PROMPT_HISTORY}${MERGE_PENDING_SUFFIX}`,
  `${PROMPT_HISTORY}.orca-profile-conflict`
]
const HISTORY_DIRS: readonly string[] = CLAUDE_PROFILE_HISTORY_DIRS
const MEASURE_CONCURRENCY = 16

class RetainedHistoryUnreadableError extends Error {}

function absentAsNull(error: unknown): null {
  if (isDefinitiveAbsence(error)) {
    return null
  }
  throw error
}

// On Windows the profile's prompt history is a hardlink to System default's; once that file is
// replaced, the old link holds only this account's prompts.
async function isLinkedPromptHistory(home: string, sharedHome: string): Promise<boolean> {
  const [own, shared] = await Promise.all(
    // Unreadable reads as not linked: the file is then kept, never deleted.
    [home, sharedHome].map((dir) =>
      lstat(join(dir, PROMPT_HISTORY), { bigint: true }).catch(() => null)
    )
  )
  return own?.isFile() === true && shared !== null && fileIdentity(own) === fileIdentity(shared)
}

/** Decides per entry; read before anything in `home` is removed, the link record included. */
async function retainedHistoryFilter(
  home: string,
  sharedHome: string
): Promise<(entry: Dirent) => boolean> {
  const linkedPromptHistory = await isLinkedPromptHistory(home, sharedHome)
  // History only this account holds: what never became a link into System default. Links, the
  // sign-in, `.claude.json` and settings are never retained.
  return (entry) => {
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
    return entry.name === PROMPT_HISTORY && entry.isFile() && !linkedPromptHistory
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(absentAsNull)
  return stats !== null && stats.isDirectory() && !stats.isSymbolicLink()
}

/** Bytes of files under one retained entry, never through a link; unreadable parts fail it. */
async function measureEntry(path: string): Promise<number> {
  const scan = await scanWorkspaceSpaceEntryTree<Dirent>({
    rootPath: path,
    rootName: basename(path),
    concurrency: MEASURE_CONCURRENCY,
    entryName: (child) => child.name,
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
  return scan.sizeBytes
}

/** Bytes of files in the retained entries; an unreadable entry fails the whole measurement. */
export async function measureRetainedClaudeHistory(
  folder: string,
  sharedHome: string
): Promise<number> {
  const home = join(folder, 'home')
  if (!(await isRealDirectory(folder)) || !(await isRealDirectory(home))) {
    return 0
  }
  const retained = await retainedHistoryFilter(home, sharedHome)
  let bytes = 0
  for (const entry of await readdir(home, { withFileTypes: true })) {
    if (retained(entry)) {
      bytes += await measureEntry(join(home, entry.name))
    }
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
  const stats = await lstat(path).catch(absentAsNull)
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

async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch((error: unknown) => {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
      throw error
    }
  })
}

// Only rmdir: it refuses a folder a writer just put a file in, so pruning never deletes history.
async function pruneEmptyDirectories(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await pruneEmptyDirectories(join(dir, entry.name))
    }
  }
  await removeIfEmpty(dir)
}

/**
 * Delete an account folder (`claude-profiles/<id>`). Its retained conversations stay unless the
 * user asked to delete them; retained folders that hold no files go.
 */
export async function removeClaudeProfileFolder(
  folder: string,
  options: { deleteRetainedHistory: boolean; sharedHome: string }
): Promise<void> {
  if (!(await isRealDirectory(folder))) {
    await removeWithoutFollowingLinks(folder)
    return
  }
  const home = join(folder, 'home')
  const homeIsReal = await isRealDirectory(home)
  if (homeIsReal) {
    const retained = options.deleteRetainedHistory
      ? () => false
      : await retainedHistoryFilter(home, options.sharedHome)
    // Decided per entry as it is removed, so history a writer adds meanwhile is never swept up.
    for (const entry of await readdir(home, { withFileTypes: true })) {
      const path = join(home, entry.name)
      if (!retained(entry)) {
        await removeWithoutFollowingLinks(path)
      } else if (entry.isDirectory()) {
        await pruneEmptyDirectories(path).catch(() => {})
      }
    }
  }
  for (const entry of await readdir(folder)) {
    if (entry !== 'home' || !homeIsReal) {
      await removeWithoutFollowingLinks(join(folder, entry))
    }
  }
  await removeIfEmpty(home)
  await removeIfEmpty(folder)
}

const GUEST_PREAMBLE = [
  'set -u -o pipefail',
  'folder=$1',
  'home=$folder/home',
  'kept() {',
  '  [ -L "$1" ] && return 1',
  '  case "${1##*/}" in',
  `    *${MERGE_PENDING_SUFFIX} | ${PROMPT_HISTORY_ASIDE.map((prefix) => `${prefix}*`).join(' | ')}) [ -e "$1" ] ;;`,
  `    ${HISTORY_DIRS.join(' | ')}) [ -d "$1" ] ;;`,
  // Linux guests share prompt history through a symlink, never a hardlink.
  `    ${PROMPT_HISTORY}) [ -f "$1" ] ;;`,
  '    *) return 1 ;;',
  '  esac',
  '}',
  // A linked folder or home must never be walked: its entries belong to the link target.
  'real_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }',
  'entries() { for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
  '  if [ -e "$entry" ] || [ -L "$entry" ]; then printf "%s\\0" "$entry"; fi',
  'done; }',
  // Fails rather than undercount: an unreadable home would otherwise list as empty.
  'listable_home() { real_dir "$folder" && real_dir "$home" && { [ -r "$home" ] && [ -x "$home" ] || exit 1; }; }',
  `entry_bytes() { find "$1" -type f -printf '%s\\n' | awk '{ s += $1 } END { printf "%.0f", s }'; }`,
  'measure_total() {',
  '  local total=0 entry size',
  '  if listable_home; then',
  '    while IFS= read -r -d "" entry; do',
  '      kept "$entry" || continue',
  '      size=$(entry_bytes "$entry") || exit 1',
  '      total=$((total + size))',
  '    done < <(entries "$home")',
  '  fi',
  '  printf "%s\\n" "$total"',
  '}'
]

/** Guest twin of `removeClaudeProfileFolder`; GNU rm removes a link itself, never its target. */
export const GUEST_REMOVE_KEEPING_HISTORY_SCRIPT = [
  ...GUEST_PREAMBLE,
  'real_dir "$folder" || { rm -f -- "$folder"; exit; }',
  'failed=0',
  'remove() { rm -rf -- "$1" || failed=1; }',
  'if listable_home; then',
  '  while IFS= read -r -d "" entry; do',
  '    if [ "${2:-}" = delete ] || ! kept "$entry"; then remove "$entry"',
  // find -delete on an empty folder is rmdir, which refuses one a writer just filled.
  '    elif [ -d "$entry" ]; then find "$entry" -depth -type d -empty -delete 2>/dev/null; fi',
  '  done < <(entries "$home")',
  'fi',
  'while IFS= read -r -d "" entry; do',
  '  { [ "$entry" = "$home" ] && real_dir "$home"; } || remove "$entry"',
  'done < <(entries "$folder")',
  'rmdir -- "$home" "$folder" 2>/dev/null',
  'exit "$failed"'
].join('\n')

/** Guest twin of `measureRetainedClaudeHistory`: prints the byte total, or fails. */
export const GUEST_MEASURE_HISTORY_SCRIPT = [...GUEST_PREAMBLE, 'measure_total'].join('\n')
