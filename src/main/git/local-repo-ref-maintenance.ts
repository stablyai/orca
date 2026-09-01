import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  PACK_REFS_ARGS,
  PACK_REFS_TIMEOUT_MS,
  RepoRefMaintenance,
  type RepoRefMaintenanceTarget
} from '../../shared/repo-ref-maintenance'
import { isWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { withSpan } from '../observability/tracer'
import { gitExecFileAsync } from './runner'
import { readRepoCommonDirFromGit } from './worktree-list-reader'

/**
 * Main-process wiring for idle loose-ref packing on the local execution host
 * (native and WSL).
 *
 * SSH-hosted repos are deliberately out of scope: the execution host owns
 * anything that touches execution, so maintaining them means running host-side
 * on the relay, which today has neither admission control nor spans. Keying all
 * state by execution host is what keeps this path from reaching across.
 */

export type RepoMaintenanceActivityProbe = () => boolean

let activityProbe: RepoMaintenanceActivityProbe | null = null
let shared: RepoRefMaintenance | null = null

/**
 * Register the app-wide "do not start maintenance now" signal. Owned by the
 * main entry point because the inputs (live agents, battery, quit) are not
 * visible from the git layer.
 */
export function setRepoMaintenanceActivityProbe(probe: RepoMaintenanceActivityProbe | null): void {
  activityProbe = probe
}

/** Support escape hatch: kills the sweep without touching the user's git config. */
function isDisabled(): boolean {
  return process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE === '1'
}

export function getLocalRepoRefMaintenance(): RepoRefMaintenance {
  shared ??= new RepoRefMaintenance({
    // Fail closed: without the app-level gate installed we cannot see agents,
    // creates, or battery, and running blind is worse than not running.
    isBusy: () => activityProbe?.() ?? true,
    observe: (attempt) =>
      withSpan('repo.ref_maintenance', (span) => attempt(span), {
        attributes: { kind: 'git', 'repo.maintenance_host': 'local' }
      }),
    onError: (error) => {
      console.warn('[repo-ref-maintenance] attempt failed:', error)
    }
  })
  return shared
}

/** Cancels every armed quiet-period timer. Safe when nothing was ever armed. */
export function disposeLocalRepoRefMaintenance(): void {
  shared?.dispose()
  shared = null
}

export function _resetLocalRepoRefMaintenanceForTests(): void {
  shared?.dispose()
  shared = null
  activityProbe = null
}

/**
 * Git reports the common dir in its own execution space, so a WSL repo answers
 * with a Linux path the Windows main process cannot open. Translate it back to
 * the UNC spelling for the dirent walk; the walk reads directories, not files,
 * so the handful of round trips stays cheap even over the share.
 */
function refsDirectoryForMainProcess(commonDir: string, wslDistro: string | undefined): string {
  if (wslDistro && !isWslUncPath(commonDir) && !isWindowsAbsolutePathLike(commonDir)) {
    return win32.join(toWindowsWslPath(commonDir, wslDistro), 'refs')
  }
  // Decided by path syntax, not by platform: `win32.isAbsolute` accepts POSIX paths too.
  return (isWindowsAbsolutePathLike(commonDir) ? win32 : posix).join(commonDir, 'refs')
}

/**
 * `maintenance.auto=false` and `gc.auto=0` are the two knobs a user reaches for
 * to tell Git to stop maintaining a repository on its own. Orca sets both on its
 * own fetches, but only as per-invocation `-c` flags, so this probe sees the
 * user's persisted config and never Orca's own suppression.
 */
export function isGitAutoMaintenanceDisabled(configOutput: string): boolean {
  return configOutput
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === 'maintenance.auto false' || line === 'gc.auto 0')
}

export type LocalRepoRefMaintenanceTargetArgs = {
  /** `${runtimeKey}::${gitCommonDir}` -- already scoped to the execution host. */
  readonly key: string
  readonly repoPath: string
  readonly wslDistro?: string
  /** True while this repo has a fetch or create in flight. */
  readonly isBusy: () => boolean
}

/**
 * Record a write to this repo and restart its quiet-period countdown. The only
 * entry point callers need: the kill switch is honoured before anything is
 * scheduled, so a disabled build arms no timers at all.
 */
export function armLocalRepoRefMaintenance(args: LocalRepoRefMaintenanceTargetArgs): void {
  if (isDisabled()) {
    return
  }
  getLocalRepoRefMaintenance().arm(createLocalRepoRefMaintenanceTarget(args))
}

export function createLocalRepoRefMaintenanceTarget(
  args: LocalRepoRefMaintenanceTargetArgs
): RepoRefMaintenanceTarget {
  const gitOptions = args.wslDistro ? { wslDistro: args.wslDistro } : {}
  return {
    key: args.key,
    isBusy: args.isBusy,
    async resolveRefsDirectory() {
      const commonDir = await readRepoCommonDirFromGit(args.repoPath, gitOptions)
      return commonDir ? refsDirectoryForMainProcess(commonDir, args.wslDistro) : undefined
    },
    async isOptedOut() {
      try {
        const { stdout } = await gitExecFileAsync(
          ['config', '--get-regexp', '^(maintenance\\.auto|gc\\.auto)$'],
          { cwd: args.repoPath, ...gitOptions, admissionTier: 'background' }
        )
        return isGitAutoMaintenanceDisabled(stdout)
      } catch {
        // Neither key set is the common case and exits non-zero; that is consent.
        return false
      }
    },
    async packRefs() {
      await gitExecFileAsync([...PACK_REFS_ARGS], {
        cwd: args.repoPath,
        ...gitOptions,
        admissionTier: 'background',
        timeout: PACK_REFS_TIMEOUT_MS
      })
    }
  }
}
