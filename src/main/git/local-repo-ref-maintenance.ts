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

const REPO_BUSY_PROBE_MAX = 64

let activityProbe: RepoMaintenanceActivityProbe | null = null
let shared: RepoRefMaintenance | null = null
// Why keyed here rather than captured in the target: a repo can be armed from
// the fetch controller or from a user-initiated fetch, and every arming must see
// the same "this repo has work in flight" answer, not whichever closure was last.
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

function localMaintenanceOptions(): RepoRefMaintenanceOptions {
  return {
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
  }
}

export function getLocalRepoRefMaintenance(): RepoRefMaintenance {
  shared ??= new RepoRefMaintenance(localMaintenanceOptions())
  return shared
}

/**
 * Cancels every armed timer and waits out any `packed-refs` rewrite in progress.
 *
 * Deliberately does not kill the child. A pack orphaned by the app quitting
 * finishes on its own; a pack signalled mid-prune strands a ref lock about one
 * time in five, and on Windows a force-kill inside the rewrite strands
 * `packed-refs.lock` every time -- which blocks every later ref deletion.
 */
export function disposeLocalRepoRefMaintenance(): Promise<void> {
  const settling = shared?.awaitPackedRefsLockRelease() ?? Promise.resolve()
  shared?.dispose()
  shared = null
  repoBusyProbes.clear()
  return settling
}

/**
 * Hold every repository open while `run` touches refs.
 *
 * A ref deletion needs `packed-refs.lock`, which a running pack holds only while
 * it rewrites the file -- 0.03-1.37s of a 23-32s run. Waiting that out turns the
 * collision into a short pause. Cancelling the pack instead would strand a
 * `refs/**` lock about one time in five, which Git never clears, so the ref
 * stays undeletable indefinitely.
 */
export async function withRepoRefMaintenancePaused<T>(
  reason: string,
  run: () => Promise<T>
): Promise<T> {
  // Taken unconditionally rather than only when something is already armed: a
  // fetch inside `run` can arm the sweep, and one counter bump against an idle
  // instance costs a microtask. This can rebuild the instance after the
  // quit-time dispose; harmless, because a fresh one has no armed timers and its
  // activity probe is gone, so it fails closed.
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

/**
 * Count user-initiated ref work as activity and restart every armed countdown.
 *
 * Deliberately not keyed to a repo: resolving one would cost a `rev-parse` on a
 * path the user is waiting on, and a manual fetch or pull says the user is at
 * the keyboard, which is a reason to defer every repository.
 */
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

/**
 * The common dir in the spelling the main process can open.
 *
 * Derived from the converted refs path, not the raw one: a WSL answer arrives as
 * a Linux path but converts to a UNC path with no `/` in it, so choosing the
 * path flavour before conversion collapses the whole thing to `.`.
 */
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
  // The engine always probes before it packs, so the pack reuses this answer
  // rather than spending a second rev-parse on the same repository.
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
      } catch {
        // Neither key set is the common case and exits non-zero; that is consent.
        return false
      }
    },
    async packRefs(lock: PackedRefsLockReporter) {
      const resolved = await resolveCommonDir()
      const owner = resolved
        ? new PackRefsLockOwnership(gitCommonDirForMainProcess(resolved, args.wslDistro))
        : null
      const claim = owner ? await owner.claim() : { ok: true as const }
      if (!claim.ok) {
        throw new RefMaintenanceRepoLocked(claim.reason)
      }
      // Report the rewrite window rather than accepting a signal. A pack that is
      // killed mid-prune strands a `refs/**` lock about one time in five, and
      // Git never clears those; waiting out the window costs at most ~1.4s.
      const watch = owner?.watchLock((held) => lock.setHeld(held))
      try {
        await gitExecFileAsync([...PACK_REFS_ARGS], {
          cwd: args.repoPath,
          ...gitOptions,
          admissionTier: 'background',
          timeout: PACK_REFS_TIMEOUT_MS
        })
      } finally {
        watch?.stop()
        lock.setHeld(false)
        await owner?.release()
      }
    }
  }
}
