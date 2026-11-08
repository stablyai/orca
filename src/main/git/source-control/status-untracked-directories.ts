import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { bulkPathspecCommands } from './git-pathspec'

/**
 * How to get every untracked file: `expand` lists configured-mode `? dir/` rows, `configured-all` needs nothing,
 * `uall` passes `-uall` (mode `no`, untracked cache disabled, or unreadable config).
 */
export type UntrackedScan = 'expand' | 'configured-all' | 'uall'

const UNTRACKED_SCAN_CONFIG_PATTERN =
  '^(status\\.showuntrackedfiles|core\\.untrackedcache|feature\\.manyfiles)$'
const LIST_OTHER_FILES_ARGS = ['ls-files', '--others', '--exclude-standard', '-z', '--']

/** Git's untracked cache only serves scans in its stored mode, which follows `status.showUntrackedFiles`. */
export async function readUntrackedScan(
  worktreePath: string,
  options: GetStatusOptions
): Promise<UntrackedScan> {
  let stdout = ''
  try {
    stdout = (
      await gitExecFileAsync(
        ['config', '--get-regexp', UNTRACKED_SCAN_CONFIG_PATTERN],
        gitReadOptionsForWorktree(worktreePath, options)
      )
    ).stdout
  } catch (error) {
    // Exit 1 means none of the keys are set: default mode, cache kept as the index has it.
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 1)) {
      return 'uall'
    }
  }
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(' ')
    const key = separator === -1 ? line.trim() : line.slice(0, separator)
    if (key) {
      // Later lines win, as in Git; a bare key is boolean true.
      values.set(
        key,
        separator === -1
          ? 'true'
          : line
              .slice(separator + 1)
              .trim()
              .toLowerCase()
      )
    }
  }
  const mode = values.get('status.showuntrackedfiles') ?? 'normal'
  if (mode === 'all') {
    return 'configured-all'
  }
  const cache = values.get('core.untrackedcache')
  // Without a cache the configured scan costs as much as -uall, so the extra listing would be pure overhead.
  if (isGitFalse(mode) || (cache !== undefined && isGitFalse(cache))) {
    return 'uall'
  }
  return 'expand'
}

/** Git's boolean false spellings; newer Git also accepts them for `status.showUntrackedFiles` (= `no`). */
function isGitFalse(value: string): boolean {
  return ['no', 'false', 'off'].includes(value) || (/^[+-]?\d+$/.test(value) && Number(value) === 0)
}

/**
 * List the files `-uall` would report under collapsed `? dir/` rows, keyed by row; null asks for a `-uall` rescan.
 * Stops after `maxPaths` (0 = unbounded): the k-th listed file lands at row k or later, past any cap.
 */
export async function listUntrackedDirectoryFiles(
  worktreePath: string,
  directories: readonly string[],
  maxPaths: number,
  options: GetStatusOptions
): Promise<Map<string, string[]> | null> {
  // Rows outside cwd (status run from a subdirectory) cannot be listed relative to it.
  if (directories.some((dir) => dir.startsWith('./') || dir.startsWith('../'))) {
    return null
  }
  const commands = bulkPathspecCommands(
    LIST_OTHER_FILES_ARGS,
    directories,
    worktreePath,
    options.wslDistro ? { wslDistro: options.wslDistro } : {}
  )
  // Each extra chunk rereads the index; that many directories favour one -uall scan.
  if (commands.length !== 1) {
    return null
  }
  const filesByDirectory = new Map<string, string[]>(directories.map((dir) => [dir, []]))
  let listed = 0
  const addPath = (filePath: string): boolean => {
    const files = filesByDirectory.get(owningDirectory(filePath, filesByDirectory))
    if (files) {
      files.push(filePath)
      listed += 1
    }
    return maxPaths !== 0 && listed >= maxPaths
  }
  let carry = ''
  const result = await gitStreamStdout(commands[0], {
    cwd: worktreePath,
    wslDistro: options.wslDistro,
    admissionTier: options.admissionTier,
    preferWslDirectGit: true,
    env: gitOptionalLocksDisabledEnv(),
    signal: options.signal,
    onStdout: (chunk) => {
      const records = (carry + chunk).split('\0')
      carry = records.pop() ?? ''
      return records.some((filePath) => filePath.length > 0 && addPath(filePath))
    }
  })
  if (!result.stoppedEarly && carry.length > 0) {
    addPath(carry)
  }
  // A row status just reported cannot be empty; trust -uall over a race or an older Git's listing quirk.
  if (!result.stoppedEarly && [...filesByDirectory.values()].some((files) => files.length === 0)) {
    return null
  }
  return filesByDirectory
}

/** Status rows never nest, so at most one prefix matches; a nested repository lists as the directory itself. */
function owningDirectory(filePath: string, directories: ReadonlyMap<string, unknown>): string {
  for (let end = filePath.lastIndexOf('/'); end >= 0; end = filePath.lastIndexOf('/', end - 1)) {
    const prefix = filePath.slice(0, end + 1)
    if (directories.has(prefix)) {
      return prefix
    }
    if (end === 0) {
      break
    }
  }
  return ''
}
