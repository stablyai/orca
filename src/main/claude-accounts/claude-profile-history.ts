import { mkdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { join, resolve, toNamespacedPath } from 'node:path'
import { loadHistoryFilesystem, type HistoryDirectory } from '../../shared/history-filesystem'
import { drainDirectory, retry } from './claude-profile-history-drain'
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

// Exclude `sessions`: its live-process registry belongs to each folder's daemon.
export const CLAUDE_PROFILE_HISTORY_DIRS = [
  'projects',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'paste-cache',
  'tasks',
  'plans',
  'transcripts'
] as const

/** Pending entries are never traversal paths. */
export function mergeClaudeProfileDirectory(
  profile: string,
  home: string,
  name: string,
  _platform: NodeJS.Platform,
  report: ClaudeProfileReport
): ClaudeProfileSurfaceOutcome {
  const binding = loadHistoryFilesystem()
  const destinationPath = resolve(home, name)
  const pending = `${name}${CLAUDE_PROFILE_MERGE_SUFFIX}`
  const pendingPath = join(profile, pending)
  const parent = binding.openDirectory(profile, false)
  let destination: HistoryDirectory | undefined
  try {
    mkdirSync(destinationPath, { recursive: true })
    destination = binding.openDirectory(destinationPath, true)
    const target = destination
    const restore = (): void => {
      if (retry(() => parent.move(pending, parent, name)) === 'collision') {
        if (parent.kind(pending) === 'directory' && parent.kind(name) === 'directory') {
          const original = retry(() => parent.open(name))
          try {
            drainDirectory(parent, pending, original, report, name, pendingPath)
          } finally {
            original.close()
          }
        } else {
          throw new ClaudeProfileSurfaceError(
            'retained-conflict',
            `Earlier entries kept in ${pendingPath}`
          )
        }
      }
    }
    const previous = parent.kind(pending)
    if (previous === 'directory') {
      try {
        const captured = retry(() => parent.open(pending))
        let sameDevice: boolean
        try {
          sameDevice = captured.sameDevice(target)
        } finally {
          captured.close()
        }
        if (!sameDevice) {
          // Restore only into an absent H; an occupied H keeps P where it is.
          retry(() => parent.move(pending, parent, name))
          throw crossFilesystem()
        }
        drainDirectory(parent, pending, target, report, name, pendingPath)
      } catch (error) {
        if (error instanceof ClaudeProfileSurfaceError && error.code === 'cross-filesystem') {
          throw error
        }
        warnClaudeProfile(report, name, error)
      }
    } else if (previous !== null) {
      // A stale staged link is opaque, including on the first call after interruption.
      restore()
    }
    let staged = false
    const current = parent.kind(name)
    if (current === 'link') {
      const linked = resolve(profile, parent.readLink(name))
      return realpathSync(linked) === realpathSync(destinationPath) ? 'unchanged' : 'user-owned'
    }
    if (current !== null && current !== 'directory') {
      return 'user-owned'
    }
    if (current === 'directory') {
      const captured = retry(() => parent.open(name))
      let sameDevice: boolean
      try {
        if (captured.same(target)) {
          return 'unchanged'
        }
        sameDevice = captured.sameDevice(target)
      } finally {
        captured.close()
      }
      if (!sameDevice) {
        throw crossFilesystem()
      }
      const moved = retry(() => parent.move(name, parent, pending, true))
      staged = moved === 'moved'
      if (moved === 'collision') {
        throw new ClaudeProfileSurfaceError(
          'retained-conflict',
          `Earlier conflicts kept in ${pendingPath}`
        )
      }
      if (parent.kind(pending) !== 'directory' && parent.kind(pending) !== null) {
        restore()
        throw new ClaudeProfileSurfaceError(
          'retained-conflict',
          `Changed source restored from ${pendingPath}`
        )
      }
    }
    try {
      retry(() => parent.link(name, toNamespacedPath(destinationPath)))
    } catch (error) {
      // A rival's staged P is its own to restore.
      if (staged) {
        try {
          restore()
        } catch (restoreError) {
          warnClaudeProfile(report, name, restoreError)
        }
      }
      throw new ClaudeProfileSurfaceError('link-failed', String(error))
    }
    if (staged && parent.kind(pending) === 'directory') {
      drainDirectory(parent, pending, target, report, name, pendingPath)
    }
    return 'linked'
  } finally {
    destination?.close()
    parent.close()
  }
}

// Undo legacy session sharing; Claude recreates its per-folder process registry.
function unlinkSharedSessions(profile: string, home: string): ClaudeProfileSurfaceOutcome {
  const source = join(profile, 'sessions')
  if (!lstatIfPresent(source)?.isSymbolicLink()) {
    return 'unchanged'
  }
  if (realpathSync(source) !== realpathSync(join(home, 'sessions'))) {
    return 'user-owned'
  }
  try {
    unlinkSync(source)
  } catch {
    // A Windows junction is removed as a directory.
    rmdirSync(source)
  }
  return 'synced'
}

/** Call after profile ownership checks and creation on the execution host. */
export async function shareClaudeProfileHistory(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileReport> {
  loadHistoryFilesystem()
  const report = createClaudeProfileReport()
  const platform = args.platform ?? process.platform
  const defaultHome = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  mkdirSync(defaultHome, { recursive: true, mode: 0o700 })
  for (const name of CLAUDE_PROFILE_HISTORY_DIRS) {
    await runClaudeProfileSurface(report, name, () =>
      mergeClaudeProfileDirectory(args.profileHome, defaultHome, name, platform, report)
    )
  }
  await runClaudeProfileSurface(report, 'sessions', () =>
    unlinkSharedSessions(args.profileHome, defaultHome)
  )
  await runClaudeProfileSurface(report, 'history.jsonl', () =>
    mergeClaudeProfilePromptHistory(args.profileHome, defaultHome, platform, report)
  )
  return report
}
