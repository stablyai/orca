import type { JobTerminationOutcome } from './windows/windows-pty-job'
import {
  terminateWindowsProcessTree,
  WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
  type WindowsTreeKiller
} from './windows-process-tree-kill'
import {
  verifyWindowsTreeKillTarget,
  WINDOWS_ROOT_IDENTITY_TIMEOUT_MS,
  type WindowsTreeKillTarget
} from './windows-pty-root-identity'

// Leave room before the session's independent 5s forced-root deadline.
const DEFAULT_WINDOWS_SWEEP_TIMEOUT_MS = 4_000

/**
 * Bounded Windows side of the descendant sweep.
 *
 * Why a separate module: the Windows fallback needs probe scaling, an
 * escalation race, and a killRoot deadline on top of the shared sequencing,
 * and that machinery does not fit the core module's line budget. POSIX needs
 * none of it — its snapshot, grace window, and re-read are already
 * constant-bounded — so the core keeps the POSIX branch inline and only
 * Windows dispatches here.
 */

export type WindowsSweepDeps = {
  platform?: NodeJS.Platform
  awaitEscalation?: boolean | (() => boolean)
  ownsRoot?: () => boolean
  /**
   * Terminate the PTY's job object. Returns `unavailable` when this tree has
   * no job, which is not permission to assume it is gone.
   */
  terminateOwnedTree?: () => JobTerminationOutcome
  /** Injectable Windows tree killer (defaults to taskkill /T /F). */
  killWindowsTree?: WindowsTreeKiller
  /** Injectable Windows root-identity probe (defaults to a live process query). */
  verifyTreeKillTarget?: (rootPid: number) => Promise<WindowsTreeKillTarget>
  /**
   * Spawn-captured creation time of the root. Anchors the identity probe so
   * a recycled PID on another Orca descendant resolves `foreign` instead of
   * `own` (#10680). Unset refuses PID-addressed fallback.
   */
  expectedRootCreationTimeMs?: number
  /**
   * Hard bound on the Windows sweep. killRoot still fires by this deadline;
   * the root stays alive for taskkill discovery until then. Unset uses the
   * 4s budget shared with the daemon shutdown path.
   */
  sweepTimeoutMs?: number
}

function shouldAwaitEscalation(deps: WindowsSweepDeps): boolean {
  return (
    (typeof deps.awaitEscalation === 'function' ? deps.awaitEscalation() : deps.awaitEscalation) ??
    false
  )
}

type SweepBudgets = { preKillMs: number; escalationMs: number }

/** Pre-kill (probe) vs escalation share of a bounded sweep. */
function splitSweepBudget(sweepTimeoutMs: number): SweepBudgets {
  const total = Math.max(0, Math.floor(sweepTimeoutMs))
  const preKillMs = Math.floor(total * 0.4)
  return { preKillMs, escalationMs: Math.max(0, total - preKillMs) }
}

/**
 * Awaits an escalation but no longer than the sweep budget allows. The
 * escalation itself keeps running under its own timeout; this only stops
 * the caller from waiting past its shutdown budget for it.
 */
function settleEscalationWithin(
  escalation: Promise<void>,
  escalationMs: number,
  keepAlive: boolean
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), Math.max(0, escalationMs))
    if (!keepAlive) {
      timer.unref?.()
    }
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    void escalation.then(done, done)
  })
}

/**
 * Windows sweep with a killRoot deadline.
 *
 * Why the deadline fires killRoot itself instead of trusting the inner
 * bounds: an injected killer can hang forever and a wedged probe can eat
 * the whole daemon budget. Expiration also retires late probe results so
 * they cannot start a PID-addressed kill after the root handle closes.
 */
export async function runWindowsSweepWithDeadline(
  rootPid: number,
  killRoot: () => void,
  deps: WindowsSweepDeps
): Promise<void> {
  const total = Math.max(0, Math.floor(deps.sweepTimeoutMs ?? DEFAULT_WINDOWS_SWEEP_TIMEOUT_MS))
  const deadline = performance.now() + total
  const controller = new AbortController()
  let rootFired = false
  const fireRootOnce = (): void => {
    if (rootFired) {
      return
    }
    rootFired = true
    // Stop outstanding taskkill discovery before releasing the root handle.
    controller.abort()
    try {
      killRoot()
    } catch {
      // The deadline must never throw; the sweep body already ran killRoot
      // or will run it in its own finally.
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      fireRootOnce()
      resolve()
    }, total)
    if (!shouldAwaitEscalation(deps)) {
      timer.unref?.()
    }
    const run = runWindowsSweep(
      rootPid,
      fireRootOnce,
      { ...deps, sweepTimeoutMs: total },
      controller.signal,
      () => !rootFired && performance.now() < deadline
    ).catch(() => fireRootOnce())
    void run.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function runWindowsSweep(
  rootPid: number,
  killRoot: () => void,
  deps: WindowsSweepDeps & { sweepTimeoutMs: number },
  signal: AbortSignal,
  isActive: () => boolean
): Promise<void> {
  const budgets = splitSweepBudget(deps.sweepTimeoutMs)
  const verifyMs = Math.max(1, Math.min(WINDOWS_ROOT_IDENTITY_TIMEOUT_MS, budgets.preKillMs))
  const treeKillMs = Math.max(
    1,
    Math.min(WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS, budgets.escalationMs)
  )
  try {
    if (isActive() && (deps.ownsRoot?.() ?? true) && Number.isInteger(rootPid) && rootPid > 0) {
      // Why first: the job names the tree Orca created, so it is immune to the
      // pid recycling the probe below exists to guard against, and it reaches
      // descendants that reparented away from the shell.
      if (deps.terminateOwnedTree?.() === 'terminated') {
        return
      }
      // Why: ownsRoot() is JS state only, and node-pty's ConPTY exit watcher closes
      // the last shell handle before it queues the JS exit callback — Windows may
      // already have recycled this PID while the map still looks live. taskkill /T /F
      // on a recycled PID force-kills an unrelated tree, so demand OS identity first.
      // This also covers the WSL fallback (a wsl.exe root's job never reaches guest
      // processes, so terminateOwnedTree reports `unavailable` and lands here too).
      const verify =
        deps.verifyTreeKillTarget ??
        ((pid: number) =>
          verifyWindowsTreeKillTarget(pid, {
            timeoutMs: verifyMs,
            ...(deps.expectedRootCreationTimeMs !== undefined
              ? { expectedCreationTimeMs: deps.expectedRootCreationTimeMs }
              : {})
          }))
      const target = await verify(rootPid).catch((): WindowsTreeKillTarget => 'unknown')
      // Re-check ownership: the identity query awaits, so exit can land meanwhile.
      if (isActive() && target === 'own' && (deps.ownsRoot?.() ?? true)) {
        const killTree =
          deps.killWindowsTree ??
          ((pid: number) =>
            terminateWindowsProcessTree(pid, {
              timeoutMs: treeKillMs,
              site: 'pty-descendant-sweep',
              signal
            }))
        // taskkill discovers descendants asynchronously; retain the root until it finishes.
        await settleEscalationWithin(
          killTree(rootPid, { signal }).catch(() => {}),
          treeKillMs,
          shouldAwaitEscalation(deps)
        )
      }
    }
  } finally {
    killRoot()
  }
}
