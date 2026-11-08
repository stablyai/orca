import { StatusPorcelainParser } from '../../../shared/git/status/git-status-porcelain-parser'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { listUntrackedDirectoryFiles, readUntrackedFilesMode } from './status-untracked-directories'

/** Failed reads keep the rows parsed before Git failed; `error` carries the failure, including aborts. */
export type StatusPorcelainRead = {
  parser: StatusPorcelainParser
  stoppedEarly: boolean
  error?: unknown
}

// Keep non-ASCII paths readable instead of Git's octal escapes.
const STATUS_ARGS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch']
const ALL_UNTRACKED_FILES_ARG = '--untracked-files=all'

/**
 * Stream porcelain v2 status with every untracked file listed, as `-uall` reports it; never rejects.
 * `-uall` bypasses Git's untracked cache unless configured, so scan in the configured mode and list only collapsed directories.
 */
export async function readStatusPorcelain(
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead> {
  if (options.includeIgnored) {
    // Git never uses the untracked cache when it also collects ignored paths.
    return streamStatusPorcelain(
      [...STATUS_ARGS, ALL_UNTRACKED_FILES_ARG, '--ignored=matching'],
      worktreePath,
      options,
      limit
    )
  }
  const [mode, read] = await Promise.all([
    readUntrackedFilesMode(worktreePath, options),
    streamStatusPorcelain(STATUS_ARGS, worktreePath, options, limit)
  ])
  if (read.error !== undefined || mode === 'all') {
    return read
  }
  if (mode === 'normal') {
    const expanded = await expandUntrackedDirectories(read, worktreePath, options, limit)
    if (expanded) {
      return expanded
    }
  }
  return streamStatusPorcelain(
    [...STATUS_ARGS, ALL_UNTRACKED_FILES_ARG],
    worktreePath,
    options,
    limit
  )
}

/** Null asks for a `-uall` rescan. */
async function expandUntrackedDirectories(
  read: StatusPorcelainRead,
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead | null> {
  const directories = read.parser.untrackedDirectoryPaths()
  if (directories.length === 0) {
    return read
  }
  let filesByDirectory: Map<string, string[]>
  try {
    filesByDirectory = await listUntrackedDirectoryFiles(
      worktreePath,
      directories,
      limit === 0 ? 0 : limit + 1,
      options
    )
  } catch (error) {
    return options.signal?.aborted ? { ...read, stoppedEarly: false, error } : null
  }
  const exceeded = read.parser.expandUntrackedDirectories(filesByDirectory, limit)
  // A capped scan whose directories emptied since cannot know the rows past Git's stop point.
  if (read.stoppedEarly && !exceeded) {
    return null
  }
  return { parser: read.parser, stoppedEarly: exceeded }
}

async function streamStatusPorcelain(
  args: string[],
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead> {
  // Bound streaming status so huge unignored folders cannot exhaust process memory.
  const parser = new StatusPorcelainParser()
  try {
    const result = await gitStreamStdout(args, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      admissionTier: options.admissionTier,
      preferWslDirectGit: true,
      // Read-only polls must not compete with terminal Git for index.lock.
      env: gitOptionalLocksDisabledEnv(),
      signal: options.signal,
      onStdout: (chunk) => parser.update(chunk, limit)
    })
    if (!result.stoppedEarly) {
      parser.finish()
    }
    return { parser, stoppedEarly: result.stoppedEarly }
  } catch (error) {
    return { parser, stoppedEarly: false, error }
  }
}
