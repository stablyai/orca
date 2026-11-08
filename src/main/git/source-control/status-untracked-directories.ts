import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { bulkPathspecCommands } from './git-pathspec'

/** How `git status` without `-u` scans untracked files; `unknown` means the config could not be read. */
export type UntrackedFilesMode = 'no' | 'normal' | 'all' | 'unknown'

const LIST_OTHER_FILES_ARGS = ['ls-files', '--others', '--exclude-standard', '-z', '--']

/** Read `status.showUntrackedFiles`; Git's untracked cache only serves scans in the mode it was stored with. */
export async function readUntrackedFilesMode(
  worktreePath: string,
  options: GetStatusOptions
): Promise<UntrackedFilesMode> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--get', 'status.showUntrackedFiles'],
      gitReadOptionsForWorktree(worktreePath, options)
    )
    return parseUntrackedFilesMode(stdout)
  } catch (error) {
    // `git config --get` exits 1 when the key is unset, which means the default mode.
    return (error as { code?: unknown }).code === 1 ? 'normal' : 'unknown'
  }
}

/** Mirrors Git's parse: newer Git also accepts booleans, where false means `no`. */
function parseUntrackedFilesMode(value: string): UntrackedFilesMode {
  const mode = value.trim().toLowerCase()
  if (mode === 'all') {
    return 'all'
  }
  if (['no', 'false', 'off'].includes(mode) || (/^[+-]?\d+$/.test(mode) && Number(mode) === 0)) {
    return 'no'
  }
  return 'normal'
}

/**
 * List the files `-uall` would report under each collapsed `? dir/` row, in Git's order.
 * Stops after `maxPaths` (0 = unbounded): the k-th listed file lands at row k or later, so later files sit past any cap.
 */
export async function listUntrackedDirectoryFiles(
  worktreePath: string,
  directories: readonly string[],
  maxPaths: number,
  options: GetStatusOptions
): Promise<Map<string, string[]>> {
  const filesByDirectory = new Map<string, string[]>(directories.map((dir) => [dir, []]))
  const commands = bulkPathspecCommands(
    LIST_OTHER_FILES_ARGS,
    directories,
    worktreePath,
    options.wslDistro ? { wslDistro: options.wslDistro } : {}
  )
  let listed = 0
  const addPath = (filePath: string): boolean => {
    const files = filesByDirectory.get(owningDirectory(filePath, filesByDirectory))
    if (files) {
      files.push(filePath)
      listed += 1
    }
    return maxPaths !== 0 && listed >= maxPaths
  }
  // Why sequential: chunks exist only past the command-line cap, and the budget carries across them.
  for (const args of commands) {
    let carry = ''
    const result = await gitStreamStdout(args, {
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
    if (result.stoppedEarly || (carry.length > 0 && addPath(carry))) {
      break
    }
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
