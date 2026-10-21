import * as path from 'node:path'
import { lstat } from 'node:fs/promises'
import type { GitStatusEntry } from '../../../shared/git-status-types'
import { StatusPorcelainParser } from '../../../shared/git-status-porcelain-parser'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  findCoveringLocalWatchRoot,
  observeLocalWatcherEvents
} from '../../ipc/local-watcher-event-observers'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import { usesHostGitForWslLinkedWorktree } from '../wsl-linked-worktree-git-routing'
import {
  withWslWindowsCheckoutGitConfig,
  wslWindowsCheckoutKey
} from '../wsl-windows-checkout-git-config'
import { DriveCheckoutSuspectPaths } from './drive-checkout-suspect-paths'
import { bulkPathspecCommands } from './git-pathspec'
import type { GetStatusOptions } from './get-status-options'
import type { GitRuntimeOptions } from '../git-runtime-options'

// Why: the later `-c` overrides the injected `core.checkStat=minimal` for just these paths.
const TARGETED_STATUS_ARGS = [
  '-c',
  'core.quotePath=false',
  '-c',
  'core.checkStat=default',
  'status',
  '--porcelain=v2',
  '--untracked-files=no',
  '--'
] as const
const TRACKER_LIMIT = 64
const STAT_CONCURRENCY = 8

const trackers = new Map<string, DriveCheckoutSuspectPaths>()
let stopObserving: (() => void) | null = null

/** Whether `args` run under the Windows-checkout minimal stat config in this checkout. */
function runsMinimalStat(
  args: string[],
  worktreePath: string,
  options: GitRuntimeOptions
): boolean {
  if (usesHostGitForWslLinkedWorktree(worktreePath, options.wslDistro)) {
    return false
  }
  return withWslWindowsCheckoutGitConfig(args, worktreePath, options.wslDistro).includes(
    'core.checkStat=minimal'
  )
}

function trackerFor(worktreePath: string, options: GetStatusOptions): DriveCheckoutSuspectPaths {
  stopObserving ??= observeLocalWatcherEvents({
    onEvents: (root, events) => {
      for (const tracker of trackers.values()) {
        tracker.recordEvents(root, events)
      }
    },
    onInterrupted: (root) => {
      for (const tracker of trackers.values()) {
        tracker.recordInterruption(root)
      }
    }
  })
  const key = wslWindowsCheckoutKey(worktreePath, options.wslDistro ?? '')
  const existing = trackers.get(key)
  if (existing) {
    return existing
  }
  if (trackers.size >= TRACKER_LIMIT) {
    const oldest = trackers.keys().next().value
    if (oldest !== undefined) {
      trackers.delete(oldest)
    }
  }
  const tracker = new DriveCheckoutSuspectPaths(worktreePath)
  trackers.set(key, tracker)
  return tracker
}

/**
 * Replaces minimal-stat unstaged rows for `checked` paths with the default-stat
 * rows. Staged rows compare index to HEAD, which checkStat never touches.
 */
export function mergeSuspectStatus(
  minimal: readonly GitStatusEntry[],
  checked: ReadonlySet<string>,
  targeted: readonly GitStatusEntry[]
): GitStatusEntry[] {
  const replacements = new Map<string, GitStatusEntry[]>()
  for (const entry of targeted) {
    if (entry.area === 'unstaged' && checked.has(entry.path)) {
      const rows = replacements.get(entry.path) ?? []
      rows.push(entry)
      replacements.set(entry.path, rows)
    }
  }
  const merged: GitStatusEntry[] = []
  for (const entry of minimal) {
    if (entry.area === 'unstaged' && checked.has(entry.path)) {
      continue
    }
    if (entry.area === 'untracked' && replacements.size > 0) {
      appendReplacements(merged, replacements, minimal)
    }
    merged.push(entry)
    const rows = replacements.get(entry.path)
    if (rows && entry.area !== 'untracked') {
      merged.push(...withRenameSource(rows, entry))
      replacements.delete(entry.path)
    }
  }
  appendReplacements(merged, replacements, minimal)
  return merged
}

function withRenameSource(rows: GitStatusEntry[], staged: GitStatusEntry): GitStatusEntry[] {
  // Why: a pathspec of only the new path cannot pair the rename; the full pass already did.
  return staged.oldPath ? rows.map((row) => ({ ...row, oldPath: staged.oldPath })) : rows
}

function appendReplacements(
  merged: GitStatusEntry[],
  replacements: Map<string, GitStatusEntry[]>,
  minimal: readonly GitStatusEntry[]
): void {
  for (const [relativePath, rows] of replacements) {
    const staged = minimal.find((entry) => entry.path === relativePath && entry.area === 'staged')
    merged.push(...(staged ? withRenameSource(rows, staged) : rows))
  }
  replacements.clear()
}

async function isRegularFileOrLink(worktreePath: string, relativePath: string): Promise<boolean> {
  const pathApi = isWindowsAbsolutePathLike(worktreePath) ? path.win32 : path.posix
  try {
    return !(await lstat(pathApi.join(worktreePath, relativePath))).isDirectory()
  } catch {
    return false
  }
}

async function readTargetedStatus(
  worktreePath: string,
  relativePaths: readonly string[],
  options: GetStatusOptions
): Promise<GitStatusEntry[]> {
  const parser = new StatusPorcelainParser()
  const commands = bulkPathspecCommands(
    TARGETED_STATUS_ARGS,
    relativePaths,
    worktreePath,
    options.wslDistro ? { wslDistro: options.wslDistro } : {}
  )
  // Why sequential: chunks exist only past the command-line cap, and each one already walks drvfs.
  for (const args of commands) {
    await gitStreamStdout(args, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      admissionTier: options.admissionTier,
      preferWslDirectGit: true,
      env: gitOptionalLocksDisabledEnv(),
      signal: options.signal,
      onStdout: (chunk) => parser.update(chunk, 0)
    })
    parser.finish()
  }
  return parser.entries
}

/**
 * Rechecks watcher-reported paths with default checkStat and overrides their
 * minimal-stat rows. Without a live watcher for the checkout this is a no-op.
 */
export async function reconcileDriveCheckoutSuspects(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GetStatusOptions
): Promise<GitStatusEntry[]> {
  if (!runsMinimalStat(['status'], worktreePath, options)) {
    return entries
  }
  const tracker = trackerFor(worktreePath, options)
  // Why reuse only: a watcher per repo for git alone would double Windows watcher cost.
  const snapshot = tracker.beginPoll(findCoveringLocalWatchRoot(worktreePath))
  if (!snapshot) {
    return entries
  }
  // Why minimal-dirty rows need no recheck: a changed stat already forced a content compare.
  const reported = new Set(
    entries
      .filter((entry) => entry.area === 'unstaged' || entry.conflictStatus !== undefined)
      .map((entry) => entry.path)
  )
  const pending = [...snapshot].filter(([relativePath, seq]) => {
    if (reported.has(relativePath)) {
      tracker.drop(relativePath, seq)
      return false
    }
    return true
  })
  const fileFlags = await mapWithConcurrency(pending, STAT_CONCURRENCY, ([relativePath]) =>
    isRegularFileOrLink(worktreePath, relativePath)
  )
  const checked = new Map<string, number>()
  pending.forEach(([relativePath, seq], index) => {
    if (fileFlags[index]) {
      checked.set(relativePath, seq)
    } else {
      tracker.drop(relativePath, seq)
    }
  })
  if (checked.size === 0) {
    return entries
  }
  let targeted: GitStatusEntry[]
  try {
    targeted = await readTargetedStatus(worktreePath, [...checked.keys()], options)
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    // Why keep the suspects: a failed recheck proved nothing about them.
    return entries
  }
  const checkedPaths = new Set(checked.keys())
  const merged = mergeSuspectStatus(entries, checkedPaths, targeted)
  const dirty = new Set(
    targeted.filter((entry) => entry.area === 'unstaged').map((entry) => entry.path)
  )
  for (const [relativePath, seq] of checked) {
    if (dirty.has(relativePath)) {
      tracker.confirmDirty(relativePath, seq)
    } else {
      tracker.drop(relativePath, seq)
    }
  }
  return merged
}

function pathspecScope(pathspec: string): string {
  const scope = pathspec
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')
  return scope === '.' ? '' : scope
}

/**
 * Suspects inside `pathspecs` (worktree-relative files or folders; `.` is the whole worktree)
 * when writes there run minimal-stat, else none. Reads only the existing tracker.
 */
export function driveCheckoutSuspectsWithin(
  worktreePath: string,
  pathspecs: readonly string[],
  options: GitRuntimeOptions
): string[] {
  const tracker = trackers.get(wslWindowsCheckoutKey(worktreePath, options.wslDistro ?? ''))
  if (!tracker || tracker.size === 0 || !runsMinimalStat(['add'], worktreePath, options)) {
    return []
  }
  const scopes = pathspecs.map(pathspecScope)
  return tracker
    .paths()
    .filter((suspect) =>
      scopes.some((scope) => scope === '' || suspect === scope || suspect.startsWith(`${scope}/`))
    )
}

export function driveCheckoutSuspectTrackerForTests(
  worktreePath: string,
  wslDistro = ''
): DriveCheckoutSuspectPaths | undefined {
  return trackers.get(wslWindowsCheckoutKey(worktreePath, wslDistro))
}

export function resetDriveCheckoutSuspectsForTests(): void {
  trackers.clear()
  stopObserving?.()
  stopObserving = null
}
