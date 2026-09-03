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
  awaitEscalation?: boolean
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
   * `own` (#10680). Unset keeps the ancestry walk.
   */
  expectedRootCreationTimeMs?: number
  /**
   * Hard bound on the Windows sweep. killRoot still fires by this deadline;
   * only this function's own settlement waits out the escalation. Unset
   * keeps the legacy behavior (inner operations bound themselves).
   */
  sweepTimeoutMs?: number
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
 * the whole daemon budget, either of which used to skip killRoot entirely
 * when the outer shutdown race gave up first. The load-bearing kill cannot
 * be starved by the escalation it precedes.
 */
export async function runWindowsSweepWithDeadline(
  rootPid: number,
  killRoot: () => void,
  deps: WindowsSweepDeps
): Promise<void> {
  if (deps.sweepTimeoutMs == null) {
    await runWindowsSweep(rootPid, killRoot, deps)
    return
  }
  const total = Math.max(0, Math.floor(deps.sweepTimeoutMs))
  let rootFired = false
  const fireRootOnce = (): void => {
    if (rootFired) {
      return
    }
    rootFired = true
    try {
      killRoot()
    } catch {
      // The deadline must never throw; the sweep body already ran killRoot
      // or will run it in its own finally.
    }
  }
  const run = runWindowsSweep(rootPid, fireRootOnce, deps).then(
    () => {},
    () => fireRootOnce()
  )
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      fireRootOnce()
      resolve()
    }, total)
    if (!(deps.awaitEscalation ?? false)) {
      timer.unref?.()
    }
    void run.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function runWindowsSweep(
  rootPid: number,
  killRoot: () => void,
  deps: WindowsSweepDeps
): Promise<void> {
  // Why scaled from the sweep budget instead of always the full probe
  // timeout: the probe plus the tree kill used to stack past the daemon's
  // shutdown budget on their own. Unset keeps the legacy full bounds.
  const budgets = deps.sweepTimeoutMs == null ? undefined : splitSweepBudget(deps.sweepTimeoutMs)
  const verifyMs = budgets
    ? Math.max(1, Math.min(WINDOWS_ROOT_IDENTITY_TIMEOUT_MS, budgets.preKillMs))
    : WINDOWS_ROOT_IDENTITY_TIMEOUT_MS
  const treeKillMs = budgets
    ? Math.max(1, Math.min(WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS, budgets.escalationMs))
    : WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS
  let treeKillEscalation: Promise<void> = Promise.resolve()
  try {
    if ((deps.ownsRoot?.() ?? true) && Number.isInteger(rootPid) && rootPid > 0) {
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
      if (target === 'own' && (deps.ownsRoot?.() ?? true)) {
        const killTree =
          deps.killWindowsTree ??
          ((pid: number) => terminateWindowsProcessTree(pid, { timeoutMs: treeKillMs }))
        // Why not awaited here: taskkill's own timeout stacked behind the
        // identity probe above can exceed the daemon's shutdown budget, which
        // let killRoot get skipped entirely when the outer shutdown race gave
        // up first. Run it as a bounded escalation instead, mirroring the
        // POSIX SIGKILL sweep, so killRoot always fires on schedule and
        // this only delays an opt-in await.
        treeKillEscalation = killTree(rootPid).catch(() => {})
      }
    }
  } finally {
    killRoot()
  }
  if (deps.awaitEscalation) {
    await (budgets
      ? settleEscalationWithin(treeKillEscalation, budgets.escalationMs, true)
      : treeKillEscalation)
  }
}
