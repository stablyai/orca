import { BoundedMap } from '../../../shared/bounded-map'
import { StatusPorcelainParser } from '../../../shared/git/status/git-status-porcelain-parser'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
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

/** Worktrees whose config or last expansion asked for -uall, so polls skip a configured scan they would discard. */
const allUntrackedWorktrees = new BoundedMap<
  string,
  { reason: 'config' | 'expansion'; atMs: number }
>({ maxEntries: 256 })
// Expansion fallbacks (many or out-of-cwd directories) tend to persist; retry the cheap scan only occasionally.
const EXPANSION_FALLBACK_RETRY_MS = 60_000

function assumesAllUntracked(worktreeKey: string): boolean {
  const memo = allUntrackedWorktrees.get(worktreeKey)
  return (
    memo !== undefined &&
    (memo.reason === 'config' || performance.now() - memo.atMs < EXPANSION_FALLBACK_RETRY_MS)
  )
}

/** Stream porcelain v2 status listing every untracked file as `-uall` does; never rejects. */
export async function readStatusPorcelain(
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead> {
  if (options.includeIgnored) {
    // Git never uses the untracked cache when it also collects ignored paths.
    return streamAllUntracked(worktreePath, options, limit, ['--ignored=matching'])
  }
  // -uall bypasses the untracked cache unless configured, so scan in the configured mode and list only collapsed rows.
  const worktreeKey = JSON.stringify([worktreePath, options.wslDistro ?? ''])
  const assumeAll = assumesAllUntracked(worktreeKey)
  const [scan, read] = await Promise.all([
    readUntrackedScan(worktreePath, options),
    assumeAll
      ? streamAllUntracked(worktreePath, options, limit)
      : streamStatusPorcelain(STATUS_ARGS, worktreePath, options, limit)
  ])
  // An aborted config read says nothing about the config.
  if (options.signal?.aborted) {
    return read
  }
  if (scan === 'uall') {
    allUntrackedWorktrees.set(worktreeKey, { reason: 'config', atMs: performance.now() })
  } else if (allUntrackedWorktrees.get(worktreeKey)?.reason === 'config' || !assumeAll) {
    allUntrackedWorktrees.delete(worktreeKey)
  }
  // A -uall read is complete whatever the config says now.
  if (assumeAll || read.error !== undefined || scan === 'configured-all') {
    return read
  }
  if (scan === 'expand') {
    const expanded = await expandUntrackedDirectories(read, worktreePath, options, limit)
    if (expanded) {
      return expanded
    }
    if (!options.signal?.aborted) {
      allUntrackedWorktrees.set(worktreeKey, { reason: 'expansion', atMs: performance.now() })
    }
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
