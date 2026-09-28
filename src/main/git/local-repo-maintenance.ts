import { RepoMaintenance } from '../../shared/repo-maintenance'
import type {
  RepoMaintenanceActivity,
  RepoMaintenanceOptions,
  RepoMaintenanceTarget
} from '../../shared/repo-maintenance-policy'
import { withSpan } from '../observability/tracer'
import type { RepoCommonDirResolver } from './git-common-dir-paths'
import { createObjectPackHousekeepingTask } from './object-pack-housekeeping-maintenance-task'
import { createPackLooseObjectsMaintenanceTask } from './pack-loose-objects-maintenance-task'
import { createPackRefsMaintenanceTask } from './pack-refs-maintenance-task'
import { gitExecFileAsync } from './runner'
import { readRepoCommonDirFromGit } from './worktree-list-reader'

/**
 * Main-process wiring for idle repo maintenance on the local execution host
 * (native and WSL).
 *
 * SSH-hosted repos are deliberately out of scope: the execution host owns
 * anything that touches execution, so maintaining them means running host-side
 * on the relay, which today has neither admission control nor spans. Keying all
 * state by execution host is what keeps this path from reaching across.
 */

export type RepoMaintenanceActivityProbe = () => RepoMaintenanceActivity

const REPO_BUSY_PROBE_MAX = 64

let activityProbe: RepoMaintenanceActivityProbe | null = null
let shared: RepoMaintenance | null = null
// Why keyed here rather than captured in the target: a repo can be armed from
// the fetch controller or from a user-initiated fetch, and every arming must see
// the same "this repo has work in flight" answer, not whichever closure was last.
const repoBusyProbes = new Map<string, () => boolean>()

/** Register the owner of "this repo has a fetch in flight" for `key`. */
export function setRepoMaintenanceBusyProbe(key: string, probe: () => boolean): void {
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
 * Register the app-wide activity signal. Owned by the main entry point because
 * the inputs (live agents, battery, load, quit) are not visible from the git
 * layer.
 */
export function setRepoMaintenanceActivityProbe(probe: RepoMaintenanceActivityProbe | null): void {
  activityProbe = probe
}

/**
 * Support escape hatch: kills the whole sweep without touching the user's git
 * config. The `_REF_` spelling is the name support has already handed out for
 * the loose-ref-only sweep this grew from, and still means the same thing.
 */
function isDisabled(): boolean {
  return (
    process.env.ORCA_DISABLE_REPO_MAINTENANCE === '1' ||
    process.env.ORCA_DISABLE_REPO_REF_MAINTENANCE === '1'
  )
}

function localMaintenanceOptions(): RepoMaintenanceOptions {
  return {
    // Fail closed: without the app-level gate installed we cannot see agents,
    // creates, or battery, and running blind is worse than not running.
    activity: () => activityProbe?.() ?? { interactive: true, constrained: true },
    observe: (attempt) =>
      withSpan('repo.maintenance', (span) => attempt(span), {
        attributes: { kind: 'git', 'repo.maintenance_host': 'local' }
      }),
    onError: (error) => {
      console.warn('[repo-maintenance] attempt failed:', error)
    }
  }
}

export function getLocalRepoMaintenance(): RepoMaintenance {
  shared ??= new RepoMaintenance(localMaintenanceOptions())
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
export function disposeLocalRepoMaintenance(): Promise<void> {
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
export async function withRepoMaintenancePaused<T>(
  reason: string,
  run: () => Promise<T>
): Promise<T> {
  // Taken unconditionally rather than only when something is already armed: a
  // fetch inside `run` can arm the sweep, and one counter bump against an idle
  // instance costs a microtask. This can rebuild the instance after the
  // quit-time dispose; harmless, because a fresh one has no armed timers and its
  // activity probe is gone, so it fails closed.
  const release = await getLocalRepoMaintenance().pause(reason)
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
 * Record that the user is at the keyboard, holding ref maintenance off for every
 * repository for a full quiet period.
 *
 * Deliberately not keyed to a repo: resolving one would cost a `rev-parse` on a
 * path the user is waiting on, and a manual fetch or pull says the user is at
 * the keyboard, which is a reason to defer every repository.
 */
export function postponeRepoMaintenance(): void {
  shared?.recordUserActivity()
}

/** `overrides` preseeds the shared instance so a test can shorten the quiet period. */
export function _resetLocalRepoMaintenanceForTests(
  overrides?: Partial<RepoMaintenanceOptions>
): void {
  shared?.dispose()
  shared = overrides ? new RepoMaintenance({ ...localMaintenanceOptions(), ...overrides }) : null
  activityProbe = null
  repoBusyProbes.clear()
}

/**
 * `maintenance.auto=false` and `gc.auto<=0` are the two knobs a user reaches for
 * to tell Git to stop maintaining a repository on its own. Orca sets both on its
 * own fetches, but only as per-invocation `-c` flags, so this probe sees the
 * user's persisted config and never Orca's own suppression. Values are Git's
 * canonical `--type` output, so every spelling Git accepts (`no`, `off`, `0`,
 * `1k`) is already normalised.
 */
export function isGitAutoMaintenanceDisabled(config: {
  maintenanceAuto?: string
  gcAuto?: string
}): boolean {
  if (config.maintenanceAuto === 'false') {
    return true
  }
  // Git's own `gc --auto` treats any threshold at or below zero as "never".
  const gcAuto = Number.parseInt(config.gcAuto ?? '', 10)
  return Number.isFinite(gcAuto) && gcAuto <= 0
}

export type LocalRepoMaintenanceTargetArgs = {
  /** `${runtimeKey}::${gitCommonDir}` -- already scoped to the execution host. */
  readonly key: string
  readonly repoPath: string
  readonly wslDistro?: string
  /** Test seam only; production uses the policy thresholds and batch size. */
  readonly taskOverrides?: { refsThreshold?: number; objectThreshold?: number; batchSize?: number }
}

/**
 * Record a write to this repo and restart its quiet-period countdown. The only
 * entry point callers need: the kill switch is honoured before anything is
 * scheduled, so a disabled build arms no timers at all.
 */
export function armLocalRepoMaintenance(args: LocalRepoMaintenanceTargetArgs): void {
  if (isDisabled()) {
    return
  }
  getLocalRepoMaintenance().arm(createLocalRepoMaintenanceTarget(args))
}

export function createLocalRepoMaintenanceTarget(
  args: LocalRepoMaintenanceTargetArgs
): RepoMaintenanceTarget {
  const gitOptions = args.wslDistro ? { wslDistro: args.wslDistro } : {}
  // Every task probes before it packs, and every task wants the same answer, so
  // one `rev-parse` is resolved for the whole target rather than per call.
  let commonDir: string | undefined
  const resolveCommonDir: RepoCommonDirResolver = async (signal?: AbortSignal) => {
    commonDir ??= await readRepoCommonDirFromGit(args.repoPath, {
      ...gitOptions,
      ...(signal ? { signal } : {})
    })
    return commonDir
  }
  const taskArgs = {
    repoPath: args.repoPath,
    ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
    resolveCommonDir
  }
  const overrides = args.taskOverrides
  return {
    key: args.key,
    isBusy: () => repoBusyProbes.get(args.key)?.() ?? false,
    // Refs first: `pack-refs` is what a worktree create and every ref
    // enumeration are waiting on, so it gets the quiet window while it is
    // certainly still quiet. Objects second -- nothing blocks on the object
    // store, and its batch re-arms for the remainder anyway.
    tasks: [
      createPackRefsMaintenanceTask({
        ...taskArgs,
        ...(overrides?.refsThreshold === undefined ? {} : { threshold: overrides.refsThreshold })
      }),
      createPackLooseObjectsMaintenanceTask({
        ...taskArgs,
        ...(overrides?.objectThreshold === undefined
          ? {}
          : { threshold: overrides.objectThreshold }),
        ...(overrides?.batchSize === undefined ? {} : { batchSize: overrides.batchSize })
      }),
      // Last: it tends the packs the object task keeps, including any it just wrote.
      createObjectPackHousekeepingTask(taskArgs)
    ],
    async isOptedOut(signal: AbortSignal) {
      const read = async (type: 'bool' | 'int', name: string): Promise<string | undefined> => {
        try {
          const { stdout } = await gitExecFileAsync(['config', `--type=${type}`, '--get', name], {
            cwd: args.repoPath,
            ...gitOptions,
            admissionTier: 'background',
            signal
          })
          return stdout.trim()
        } catch {
          // Unset exits 1, which is consent. A value Git cannot parse is not an
          // opt-out anyone can read, so it is treated the same way.
          return undefined
        }
      }
      const maintenanceAuto = await read('bool', 'maintenance.auto')
      if (isGitAutoMaintenanceDisabled({ maintenanceAuto })) {
        return true
      }
      return isGitAutoMaintenanceDisabled({ gcAuto: await read('int', 'gc.auto') })
    }
  }
}
