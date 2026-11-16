import type { Dirent } from 'node:fs'
import { lstat, opendir, readdir, readFile, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { scanWorkspaceSpaceEntryTree } from '../../../shared/workspace-disk-space/workspace-space-entry-traversal'
import { MERGE_PENDING_SUFFIX, removeDirectoryLink } from '../../filesystem/merged-directory-link'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './setup/claude-profile-history'
import { fileIdentity, PROMPT_HISTORY_LINK_RECORD } from './setup/claude-profile-prompt-history'

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

// On Windows the profile's prompt history is a hardlink to the shared file recorded at link time.
async function isLinkedPromptHistory(home: string): Promise<boolean> {
  const record = await readFile(join(home, PROMPT_HISTORY_LINK_RECORD), 'utf8').catch(absentAsNull)
  const stats = await lstat(join(home, PROMPT_HISTORY), { bigint: true })
  return record?.trim() === fileIdentity(stats)
}

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
  return entry.name === PROMPT_HISTORY && entry.isFile() && !(await isLinkedPromptHistory(home))
}

async function isRealDirectory(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(absentAsNull)
  return stats !== null && stats.isDirectory() && !stats.isSymbolicLink()
}

/** Bytes of files in the retained entries; an unreadable entry fails the whole measurement. */
export async function measureRetainedClaudeHistory(folder: string): Promise<number> {
  const home = join(folder, 'home')
  if (!(await isRealDirectory(folder)) || !(await isRealDirectory(home))) {
    return 0
  }
  let bytes = 0
  for (const entry of await readdir(home, { withFileTypes: true })) {
    if (!(await isRetainedClaudeHistory(home, entry))) {
      continue
    }
    const path = join(home, entry.name)
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

/**
 * Delete an account folder (`claude-profiles/<id>`). Its retained conversations stay unless the
 * user asked to delete them, or nothing in them is worth keeping.
 */
export async function removeClaudeProfileFolder(
  folder: string,
  options: { deleteRetainedHistory: boolean }
): Promise<void> {
  if (!(await isRealDirectory(folder))) {
    await removeWithoutFollowingLinks(folder)
    return
  }
  // An unmeasurable folder keeps its history.
  const deleteAll =
    options.deleteRetainedHistory ||
    (await measureRetainedClaudeHistory(folder).catch(() => null)) === 0
  const home = join(folder, 'home')
  const homeIsReal = await isRealDirectory(home)
  if (homeIsReal) {
    // Decide per entry as it is removed, so history a writer adds meanwhile is never swept up.
    for (const entry of await readdir(home, { withFileTypes: true })) {
      if (deleteAll || !(await isRetainedClaudeHistory(home, entry))) {
        await removeWithoutFollowingLinks(join(home, entry.name))
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
  'measure_total() {',
  '  local total=0 entry size',
  '  if real_dir "$folder" && real_dir "$home"; then',
  '    [ -r "$home" ] && [ -x "$home" ] || return 1',
  '    while IFS= read -r -d "" entry; do',
  '      kept "$entry" || continue',
  `      size=$(find "$entry" -type f -printf '%s\\n' | awk '{ s += $1 } END { printf "%.0f", s }') || return 1`,
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
  'delete_all=0',
  '[ "${2:-}" = delete ] && delete_all=1',
  '[ "$(measure_total 2>/dev/null)" = 0 ] && delete_all=1',
  'failed=0',
  'remove() { rm -rf -- "$1" || failed=1; }',
  'if real_dir "$home"; then',
  '  while IFS= read -r -d "" entry; do',
  '    { [ "$delete_all" = 0 ] && kept "$entry"; } || remove "$entry"',
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
