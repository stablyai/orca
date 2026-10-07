import { mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import { resolveClaudeDefaultHome } from './claude-profile-paths'
import {
  ClaudeProfileSurfaceError,
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'
import {
  CLAUDE_PROFILE_MERGE_SUFFIX,
  crossFilesystem,
  lstatIfPresent,
  mergeClaudeProfilePromptHistory
} from './claude-profile-prompt-history'

export const CLAUDE_PROFILE_HISTORY_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'paste-cache',
  'tasks',
  'plans',
  'transcripts'
] as const

type MoveResult = { retained: number; failed: unknown[] }

/** Keeps going past a failed entry so one locked file never hides the rest. */
function moveHistoryTree(source: string, destination: string, result: MoveResult): void {
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, item.name)
    const to = join(destination, item.name)
    try {
      const existing = lstatIfPresent(to)
      if (!existing) {
        renameFileWithWindowsRetry(from, to)
      } else if (item.isDirectory() && existing.isDirectory()) {
        moveHistoryTree(from, to, result)
      } else {
        result.retained += 1
      }
    } catch (error) {
      result.failed.push(error)
    }
  }
  if (readdirSync(source).length === 0) {
    rmdirSync(source)
  }
}

function drainDirectory(
  pending: string,
  destination: string,
  report: ClaudeProfileReport,
  name: (typeof CLAUDE_PROFILE_HISTORY_DIRS)[number]
): void {
  const result: MoveResult = { retained: 0, failed: [] }
  moveHistoryTree(pending, destination, result)
  if (result.failed.length > 0) {
    warnClaudeProfile(report, name, result.failed[0])
  }
  if (result.retained > 0) {
    const detail = `${result.retained} conflicting entries kept in ${pending}`
    warnClaudeProfile(report, name, new ClaudeProfileSurfaceError('retained-conflict', detail))
  }
}

function mergeDirectory(
  profile: string,
  home: string,
  name: (typeof CLAUDE_PROFILE_HISTORY_DIRS)[number],
  platform: NodeJS.Platform,
  report: ClaudeProfileReport
): ClaudeProfileSurfaceOutcome {
  const source = join(profile, name)
  const destination = join(home, name)
  const pending = `${source}${CLAUDE_PROFILE_MERGE_SUFFIX}`
  mkdirSync(destination, { recursive: true })
  const sameDevice = (file: string): boolean => statSync(file).dev === statSync(destination).dev
  if (lstatIfPresent(pending)?.isDirectory()) {
    if (!sameDevice(pending)) {
      if (!lstatIfPresent(source)) {
        renameFileWithWindowsRetry(pending, source)
      }
      throw crossFilesystem()
    }
    try {
      drainDirectory(pending, destination, report, name)
    } catch (error) {
      // Why: an unreadable leftover is reported and kept; it must not stop the share itself.
      warnClaudeProfile(report, name, error)
    }
  }
  const current = lstatIfPresent(source)
  if (current?.isSymbolicLink()) {
    return realpathSync(source) === realpathSync(destination) ? 'unchanged' : 'user-owned'
  }
  if (current && !current.isDirectory()) {
    return 'user-owned'
  }
  if (current) {
    if (!sameDevice(source)) {
      throw crossFilesystem()
    }
    if (lstatIfPresent(pending)) {
      throw new ClaudeProfileSurfaceError(
        'retained-conflict',
        `Earlier conflicts kept in ${pending}`
      )
    }
    renameFileWithWindowsRetry(source, pending)
  }
  try {
    // Why: a junction needs no Windows privilege; Node's lstat reports it as a symlink.
    symlinkSync(destination, source, platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (current) {
      if (!lstatIfPresent(source)) {
        renameFileWithWindowsRetry(pending, source)
      } else if (lstatIfPresent(source)?.isDirectory()) {
        moveHistoryTree(pending, source, { retained: 0, failed: [] })
      }
    }
    throw new ClaudeProfileSurfaceError('link-failed', String(error))
  }
  if (current) {
    drainDirectory(pending, destination, report, name)
  }
  return 'linked'
}

/**
 * Pools a profile's sessions and prompt history into the default home. Execution-host paths only;
 * callers go through provisionClaudeAccountProfile, which gates and creates the profile.
 */
export async function shareClaudeProfileHistory(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileReport> {
  const report = createClaudeProfileReport()
  const platform = args.platform ?? process.platform
  const defaultHome = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  mkdirSync(defaultHome, { recursive: true, mode: 0o700 })
  for (const name of CLAUDE_PROFILE_HISTORY_DIRS) {
    await runClaudeProfileSurface(report, name, () =>
      mergeDirectory(args.profileHome, defaultHome, name, platform, report)
    )
  }
  await runClaudeProfileSurface(report, 'history.jsonl', () =>
    mergeClaudeProfilePromptHistory(args.profileHome, defaultHome, platform, report)
  )
  return report
}
