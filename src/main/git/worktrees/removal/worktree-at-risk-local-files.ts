import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import type { WorktreeAtRiskLocalFiles } from '../../../../shared/worktree/at-risk-local-files'
import { gitOptionalLocksDisabledEnv } from '../../command-runner/git-environment/git-process-env'
import type { GitRuntimeOptions } from '../../command-runner/git-runtime-options'
import { gitStreamStdout } from '../../command-runner/git-stream-stdout'
import { createAbortError } from '../../command-runner/process-capture/abort-error'

// --directory collapses wholly ignored directories (node_modules/) into one row.
const LIST_IGNORED_ARGS = [
  'ls-files',
  '-z',
  '--others',
  '--ignored',
  '--exclude-standard',
  '--directory',
  '--no-empty-directory'
]
const DEFAULT_DEADLINE_MS = 8_000
const MAX_LISTED_PATHS = 5_000
const MAX_VISITED_ENTRIES = 1_000
const MAX_COMPARED_BYTES = 32 * 1024 * 1024
const MAX_COMPARED_FILE_BYTES = 4 * 1024 * 1024
const SAMPLE_PATH_LIMIT = 3

// Dependency, build and cache output that a fresh checkout regenerates.
const REGENERABLE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.expo',
  '.output',
  '.vite',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'target',
  '.gradle',
  '.dart_tool',
  'Pods',
  'vendor',
  '_build',
  '.terraform',
  'DerivedData',
  '.build',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'coverage',
  '.nyc_output'
])
const DISPOSABLE_FILE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.eslintcache'
])
const DISPOSABLE_FILE_SUFFIXES = ['.pyc', '.pyo', '.tsbuildinfo', '.log']

/** saved: a copy survives removal; unsaved: removal loses it; unknown: a budget or deadline cut the check. */
type EntryVerdict = 'saved' | 'unsaved' | 'unknown'
type ComparisonBudget = {
  entries: number
  bytes: number
  signal: AbortSignal
  worktreeRealPath: string
}

/**
 * Ignored files `git worktree remove` would delete that the main checkout has no identical copy of.
 * Regenerable output and symlinks are never at risk; the git listing and the file comparisons each get the deadline.
 */
export async function readWorktreeAtRiskLocalFiles(args: {
  worktreePath: string
  /** Identical copies here are recoverable; null counts every ignored file. */
  mainCheckoutPath: string | null
  gitOptions?: GitRuntimeOptions
  deadlineMs?: number
}): Promise<WorktreeAtRiskLocalFiles> {
  const parentSignal = args.gitOptions?.signal
  if (parentSignal?.aborted) {
    throw createAbortError()
  }
  const deadlineMs = args.deadlineMs ?? DEFAULT_DEADLINE_MS
  // Git's own timer starts after admission, so queueing behind other git work cannot cut the listing short.
  const listing = await listIgnoredPaths(args.worktreePath, args.gitOptions, deadlineMs)
  if (args.mainCheckoutPath === null) {
    return {
      count: listing.paths.length,
      samplePaths: pickNotablePaths(listing.paths),
      complete: listing.complete
    }
  }
  const signal = abortSignalWithTimeout(parentSignal, deadlineMs)
  // File reads cannot all take a signal; racing the deadline keeps a stalled mount from hanging the scan.
  const deadline = new Promise<'unknown'>((resolve) => {
    if (signal.aborted) {
      resolve('unknown')
    }
    signal.addEventListener('abort', () => resolve('unknown'), { once: true })
  })
  const worktreeRealPath = await Promise.race([
    realpath(args.worktreePath).catch(() => args.worktreePath),
    deadline
  ])
  const budget: ComparisonBudget = {
    entries: MAX_VISITED_ENTRIES,
    bytes: MAX_COMPARED_BYTES,
    signal,
    worktreeRealPath: worktreeRealPath === 'unknown' ? args.worktreePath : worktreeRealPath
  }
  const atRiskPaths: string[] = []
  let unverified = false
  for (const relativePath of listing.paths) {
    if (!hasBudgetLeft(budget)) {
      unverified = true
      break
    }
    const verdict = await Promise.race([
      readEntryVerdict(
        join(args.worktreePath, relativePath),
        join(args.mainCheckoutPath, relativePath),
        budget
      ),
      deadline
    ])
    if (verdict === 'unsaved') {
      atRiskPaths.push(relativePath)
    } else if (verdict === 'unknown') {
      unverified = true
    }
  }
  if (parentSignal?.aborted) {
    throw createAbortError()
  }
  return {
    count: atRiskPaths.length,
    samplePaths: pickNotablePaths(atRiskPaths),
    complete: listing.complete && !unverified
  }
}

async function listIgnoredPaths(
  worktreePath: string,
  options: GitRuntimeOptions = {},
  timeoutMs: number
): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = []
  const addPath = (relativePath: string): boolean => {
    if (relativePath.length > 0 && !isRegenerablePath(relativePath)) {
      paths.push(relativePath)
    }
    return paths.length >= MAX_LISTED_PATHS
  }
  let carry = ''
  try {
    const result = await gitStreamStdout(LIST_IGNORED_ARGS, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      admissionTier: options.admissionTier ?? 'background',
      preferWslDirectGit: true,
      env: gitOptionalLocksDisabledEnv(),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
      onStdout: (chunk) => {
        const records = (carry + chunk).split('\0')
        carry = records.pop() ?? ''
        return records.some(addPath)
      }
    })
    if (!result.stoppedEarly && carry.length > 0) {
      addPath(carry)
    }
    return { paths, complete: !result.stoppedEarly }
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    // A deadline, byte cap or git failure leaves the unlisted rest unknown, never safe.
    return { paths, complete: false }
  }
}

function isRegenerablePath(relativePath: string): boolean {
  const isDirectory = relativePath.endsWith('/')
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  const name = segments.pop() ?? ''
  return (
    segments.some((segment) => REGENERABLE_DIRECTORY_NAMES.has(segment)) ||
    isRegenerableEntry(name, isDirectory)
  )
}

function isRegenerableEntry(name: string, isDirectory: boolean): boolean {
  return isDirectory ? REGENERABLE_DIRECTORY_NAMES.has(name) : isDisposableFileName(name)
}

function isDisposableFileName(name: string): boolean {
  return (
    DISPOSABLE_FILE_NAMES.has(name) ||
    DISPOSABLE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  )
}

async function readEntryVerdict(
  worktreeEntry: string,
  mainEntry: string,
  budget: ComparisonBudget
): Promise<EntryVerdict> {
  if (!spendBudgetEntry(budget)) {
    return 'unknown'
  }
  let info
  try {
    info = await lstat(worktreeEntry)
  } catch {
    // Git or the directory walk just saw it; a miss means a race or a path UTF-8 decoding mangled.
    return 'unknown'
  }
  // Removal unlinks a symlink without touching its target.
  if (info.isSymbolicLink()) {
    return 'saved'
  }
  if (info.isDirectory()) {
    return readDirectoryVerdict(worktreeEntry, mainEntry, budget)
  }
  return info.isFile() ? readFileVerdict(worktreeEntry, info.size, mainEntry, budget) : 'saved'
}

async function readDirectoryVerdict(
  worktreeDirectory: string,
  mainDirectory: string,
  budget: ComparisonBudget
): Promise<EntryVerdict> {
  try {
    // Streamed so a huge directory costs at most the entry budget, never a full listing.
    for await (const child of await opendir(worktreeDirectory)) {
      if (isRegenerableEntry(child.name, child.isDirectory())) {
        if (!spendBudgetEntry(budget)) {
          return 'unknown'
        }
        continue
      }
      const verdict = await readEntryVerdict(
        join(worktreeDirectory, child.name),
        join(mainDirectory, child.name),
        budget
      )
      if (verdict !== 'saved') {
        return verdict
      }
    }
    return 'saved'
  } catch {
    return 'unknown'
  }
}

async function readFileVerdict(
  worktreeFile: string,
  size: number,
  mainFile: string,
  budget: ComparisonBudget
): Promise<EntryVerdict> {
  let resolvedMainFile
  try {
    resolvedMainFile = await realpath(mainFile)
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'unsaved' : 'unknown'
  }
  // A main-checkout symlink into this worktree is no copy: removal deletes what it points at.
  if (isPathInsideOrEqual(budget.worktreeRealPath, resolvedMainFile)) {
    return 'unsaved'
  }
  try {
    const mainInfo = await stat(resolvedMainFile)
    if (!mainInfo.isFile() || mainInfo.size !== size) {
      return 'unsaved'
    }
    if (size > MAX_COMPARED_FILE_BYTES || size * 2 > budget.bytes) {
      return 'unknown'
    }
    budget.bytes -= size * 2
    const [worktreeContent, mainContent] = await Promise.all([
      readFile(worktreeFile, { signal: budget.signal }),
      readFile(resolvedMainFile, { signal: budget.signal })
    ])
    return worktreeContent.equals(mainContent) ? 'saved' : 'unsaved'
  } catch {
    return 'unknown'
  }
}

function spendBudgetEntry(budget: ComparisonBudget): boolean {
  budget.entries -= 1
  return budget.entries >= 0 && !budget.signal.aborted
}

function hasBudgetLeft(budget: ComparisonBudget): boolean {
  return budget.entries > 0 && !budget.signal.aborted
}

function pickNotablePaths(paths: readonly string[]): string[] {
  const rank = (relativePath: string): number => (/(^|\/)\.env[^/]*\/?$/.test(relativePath) ? 0 : 1)
  return [...paths]
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        left.split('/').length - right.split('/').length ||
        left.localeCompare(right)
    )
    .slice(0, SAMPLE_PATH_LIMIT)
}
