import { BoundedMap } from '../../../../shared/bounded-map'
import { StatusPorcelainParser } from '../../../../shared/git/status/git-status-porcelain-parser'
import { gitOptionalLocksDisabledEnv } from '../../command-runner/git-environment/git-process-env'
import { gitStreamStdout } from '../../command-runner/git-stream-stdout'
import type { GetStatusOptions } from './get-status-options'
import { listUntrackedDirectoryFiles, readUntrackedScan } from './status-untracked-directories'

/** Failed reads keep the rows parsed before Git failed; `error` carries the failure, including aborts. */
export type StatusPorcelainRead = {
  parser: StatusPorcelainParser
  stoppedEarly: boolean
  error?: unknown
}

// Keep non-ASCII paths readable instead of Git's octal escapes.
const STATUS_ARGS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch']
const ALL_UNTRACKED_FILES_ARG = '--untracked-files=all'

/** When each worktree's expansion last fell back to -uall, so polls skip a configured scan they would discard. */
const expansionFallbackAtMs = new BoundedMap<string, number>({ maxEntries: 256 })
// Expansion fallbacks (many or out-of-cwd directories) tend to persist; retry the cheap scan only occasionally.
const EXPANSION_FALLBACK_RETRY_MS = 60_000

/** Rollback switch: `ORCA_GIT_STATUS_UNTRACKED_EXPANSION=0` restores the plain `-uall` scan. */
function isUntrackedExpansionEnabled(): boolean {
  return process.env.ORCA_GIT_STATUS_UNTRACKED_EXPANSION !== '0'
}

/** Stream porcelain v2 status listing every untracked file as `-uall` does; never rejects. */
export async function readStatusPorcelain(
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead> {
  // Git never uses the untracked cache when it also collects ignored paths.
  if (options.includeIgnored) {
    return streamAllUntracked(worktreePath, options, limit, ['--ignored=matching'])
  }
  const worktreeKey = JSON.stringify([worktreePath, options.wslDistro ?? ''])
  const fallbackAtMs = expansionFallbackAtMs.get(worktreeKey)
  if (
    !isUntrackedExpansionEnabled() ||
    (fallbackAtMs !== undefined && performance.now() - fallbackAtMs < EXPANSION_FALLBACK_RETRY_MS)
  ) {
    return streamAllUntracked(worktreePath, options, limit)
  }
  // -uall bypasses the untracked cache unless configured, so scan in the configured mode and list only collapsed rows.
  const scan = await readUntrackedScan(worktreePath, options)
  if (scan === 'uall') {
    return streamAllUntracked(worktreePath, options, limit)
  }
  const read = await streamStatusPorcelain(STATUS_ARGS, worktreePath, options, limit)
  if (read.error !== undefined || scan === 'configured-all') {
    return read
  }
  const expanded = await expandUntrackedDirectories(read, worktreePath, options, limit)
  if (expanded) {
    expansionFallbackAtMs.delete(worktreeKey)
    return expanded
  }
  if (!options.signal?.aborted) {
    expansionFallbackAtMs.set(worktreeKey, performance.now())
  }
  return streamAllUntracked(worktreePath, options, limit)
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
  let filesByDirectory: Map<string, string[]> | null
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
  if (!filesByDirectory) {
    return null
  }
  const exceeded = read.parser.expandUntrackedDirectories(filesByDirectory, limit)
  // A capped scan that no longer exceeds the cap cannot know the rows past Git's stop point.
  if (read.stoppedEarly && !exceeded) {
    return null
  }
  return { parser: read.parser, stoppedEarly: exceeded }
}

function streamAllUntracked(
  worktreePath: string,
  options: GetStatusOptions,
  limit: number,
  extraArgs: readonly string[] = []
): Promise<StatusPorcelainRead> {
  return streamStatusPorcelain(
    [...STATUS_ARGS, ALL_UNTRACKED_FILES_ARG, ...extraArgs],
    worktreePath,
    options,
    limit
  )
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
