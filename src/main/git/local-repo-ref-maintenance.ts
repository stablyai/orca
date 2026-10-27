import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { RepoRefMaintenance } from '../../shared/repo-ref-maintenance'
import {
  PACK_REFS_ARGS,
  PACK_REFS_TIMEOUT_MS,
  RefMaintenanceRepoLocked,
  type PackedRefsLockReporter,
  type RepoRefMaintenanceOptions,
  type RepoRefMaintenanceTarget
} from '../../shared/repo-ref-maintenance-policy'
import { isWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { withSpan } from '../observability/tracer'
import { PackRefsLockOwnership } from './pack-refs-lock-ownership'
import {
  clearRepoPackIndexMaintenanceCache,
  isUnsetGitConfigError,
  maintainRepoPackIndex
} from './repo-pack-index-maintenance'
import { gitExecFileAsync } from './runner'
import { readRepoCommonDirFromGit } from './worktree-list-reader'

// Maintain native/WSL repos locally; SSH maintenance belongs on its execution host.

export type RepoMaintenanceActivityProbe = () => boolean

const REPO_BUSY_PROBE_MAX = 64

let activityProbe: RepoMaintenanceActivityProbe | null = null
let shared: RepoRefMaintenance | null = null
// All arming paths must share the current per-repo busy probe.
const repoBusyProbes = new Map<string, () => boolean>()

/** Register the owner of "this repo has a fetch in flight" for `key`. */
export function setRepoRefMaintenanceBusyProbe(key: string, probe: () => boolean): void {
  repoBusyProbes.delete(key)
  repoBusyProbes.set(key, probe)
  while (repoBusyProbes.size > REPO_BUSY_PROBE_MAX) {
    const oldest = repoBusyProbes.keys().next()
    if (oldest.done) {
      break
    }
    repoBusyProbes.delete(oldest.value)
  }
}

/** The main entry point supplies agent, battery, creation and quit activity unavailable in the Git layer. */
export function setRepoMaintenanceActivityProbe(probe: RepoMaintenanceActivityProbe | null): void {
  activityProbe = probe
}

function isDisabled(): boolean {
  return process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE === '1'
}

function localMaintenanceOptions(): RepoRefMaintenanceOptions {
  return {
    // Without the app activity gate, defer maintenance.
    isBusy: () => activityProbe?.() ?? true,
    observe: (attempt) =>
      withSpan('repo.ref_maintenance', (span) => attempt(span), {
        attributes: { kind: 'git', 'repo.maintenance_host': 'local' }
      }),
    onError: (error) => {
      console.warn('[repo-ref-maintenance] attempt failed:', error)
    }
  }
}

export function getLocalRepoRefMaintenance(): RepoRefMaintenance {
  shared ??= new RepoRefMaintenance(localMaintenanceOptions())
  return shared
}

/** Cancel timers and await the rewrite window; never kill pack-refs, which can strand ref locks. */
export function disposeLocalRepoRefMaintenance(): Promise<void> {
  const settling = shared?.awaitPackedRefsLockRelease() ?? Promise.resolve()
  shared?.dispose()
  shared = null
  repoBusyProbes.clear()
  clearRepoPackIndexMaintenanceCache()
  return settling
}

/** Wait out packed-refs rewrites before ref work; killing the pack can strand persistent per-ref locks. */
export async function withRepoRefMaintenancePaused<T>(
  reason: string,
  run: () => Promise<T>
): Promise<T> {
  // Pause even before arming: run may schedule maintenance. Recreated shutdown instances fail closed.
  const release = await getLocalRepoRefMaintenance().pause(reason)
  try {
    return await run()
  } finally {
    release()
  }
}

/** Wait out a `packed-refs` rewrite without holding the window open. For shutdown. */
export function awaitPackedRefsLockRelease(): Promise<void> {
  return shared ? shared.awaitPackedRefsLockRelease() : Promise.resolve()
}

/** User ref work postpones every repo; resolving one would add a probe to the interactive path. */
export function postponeRepoRefMaintenance(): void {
  shared?.postponeAll()
}

/** `overrides` preseeds the shared instance so a test can shorten the quiet period. */
export function _resetLocalRepoRefMaintenanceForTests(
  overrides?: Partial<RepoRefMaintenanceOptions>
): void {
  shared?.dispose()
  shared = overrides ? new RepoRefMaintenance({ ...localMaintenanceOptions(), ...overrides }) : null
  activityProbe = null
  repoBusyProbes.clear()
  clearRepoPackIndexMaintenanceCache()
}

/** Translate WSL Git's common dir to a UNC refs directory the main process can enumerate. */
function refsDirectoryForMainProcess(commonDir: string, wslDistro: string | undefined): string {
  if (wslDistro && !isWslUncPath(commonDir) && !isWindowsAbsolutePathLike(commonDir)) {
    return win32.join(toWindowsWslPath(commonDir, wslDistro), 'refs')
  }
  // Decided by path syntax, not by platform: `win32.isAbsolute` accepts POSIX paths too.
  return (isWindowsAbsolutePathLike(commonDir) ? win32 : posix).join(commonDir, 'refs')
}

/** Read user opt-outs; Orca's per-command maintenance suppression never appears in persisted config. */
export function isGitAutoMaintenanceDisabled(configOutput: string): boolean {
  return configOutput
    .split('\n')
    .some(
      (line) =>
        /^\s*maintenance\.auto\s+(?:false|no|off|0)?\s*$/i.test(line) ||
        /^\s*gc\.auto\s+[+-]?0+(?:[kmg])?\s*$/i.test(line)
    )
}

/** Choose path syntax after WSL-to-UNC conversion; choosing before it would derive . instead. */
function gitCommonDirForMainProcess(commonDir: string, wslDistro: string | undefined): string {
  const refs = refsDirectoryForMainProcess(commonDir, wslDistro)
  return (isWindowsAbsolutePathLike(refs) ? win32 : posix).dirname(refs)
}

export type LocalRepoRefMaintenanceTargetArgs = {
  /** `${runtimeKey}::${gitCommonDir}` -- already scoped to the execution host. */
  readonly key: string
  readonly repoPath: string
  readonly wslDistro?: string
}

/** Restart the quiet period after a write; check the kill switch before arming timers. */
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
  // Reuse the required pre-pack probe instead of spending another rev-parse.
  let commonDir: string | undefined
  const resolveCommonDir = async (signal?: AbortSignal): Promise<string | undefined> => {
    commonDir ??= await readRepoCommonDirFromGit(args.repoPath, {
      ...gitOptions,
      ...(signal ? { signal } : {})
    })
    return commonDir
  }
  return {
    key: args.key,
    isBusy: () => repoBusyProbes.get(args.key)?.() ?? false,
    async resolveRefsDirectory(signal: AbortSignal) {
      const resolved = await resolveCommonDir(signal)
      return resolved ? refsDirectoryForMainProcess(resolved, args.wslDistro) : undefined
    },
    async isOptedOut(signal: AbortSignal) {
      try {
        const { stdout } = await gitExecFileAsync(
          ['config', '--get-regexp', '^(maintenance\\.auto|gc\\.auto)$'],
          { cwd: args.repoPath, ...gitOptions, admissionTier: 'background', signal }
        )
        return isGitAutoMaintenanceDisabled(stdout)
      } catch (error) {
        if (isUnsetGitConfigError(error)) {
          return false
        }
        // A failed probe blocks writers and retries without claiming a user opt-out.
        throw error
      }
    },
    async maintainPackIndex(signal, span, canWrite) {
      const resolved = await resolveCommonDir(signal)
      if (resolved) {
        return maintainRepoPackIndex({
          repoPath: args.repoPath,
          commonDir: gitCommonDirForMainProcess(resolved, args.wslDistro),
          ...gitOptions,
          signal,
          span,
          canWrite
        })
      }
      return 'failed'
    },
    async packRefs(
      lock: PackedRefsLockReporter,
      admissionSignal?: AbortSignal,
      canStart?: () => boolean
    ) {
      const resolved = await resolveCommonDir()
      const owner = resolved
        ? new PackRefsLockOwnership(gitCommonDirForMainProcess(resolved, args.wslDistro))
        : null
      const claim = owner ? await owner.claim() : { ok: true as const }
      if (!claim.ok) {
        throw new RefMaintenanceRepoLocked(claim.reason)
      }
      // Cancel admission only: killing a running pack can strand persistent per-ref locks.
      const watch = owner?.watchLock((held) => lock.setHeld(held))
      try {
        await gitExecFileAsync([...PACK_REFS_ARGS], {
          cwd: args.repoPath,
          ...gitOptions,
          admissionTier: 'background',
          timeout: PACK_REFS_TIMEOUT_MS,
          admissionSignal,
          canStart
        })
      } finally {
        watch?.stop()
        lock.setHeld(false)
        await owner?.release()
      }
    }
  }
}
