import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { constants, getPriority, setPriority } from 'node:os'
import { windowsSystem32Binary } from './windows-system-binary'

/** Only a successful taskkill proves the entire tree exited. */
export type WindowsTreeKillVerdict = 'live' | 'unverifiable' | 'exited'
export type SettledWindowsTreeKillVerdict = Exclude<WindowsTreeKillVerdict, 'live'>

export const WINDOWS_TASKKILL_WAIT_MS = 5_000
// Outlive the caller wait: killing the root before taskkill reads it can orphan descendants.
export const WINDOWS_TASKKILL_DEADLINE_MS = 30_000
// Bound taskkill after root exit: Windows may reuse the PID once Node releases its handle.
export const WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS = 2_000

export type WindowsTreeKill = {
  verdict: () => WindowsTreeKillVerdict
  settled: Promise<SettledWindowsTreeKillVerdict>
}

type TaskkillLauncher = (rootPid: number) => ChildProcess

const launchSystemTaskkill: TaskkillLauncher = (rootPid) =>
  nodeSpawn(windowsSystem32Binary('taskkill.exe'), ['/pid', String(rootPid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: false
  })

let launchTaskkill: TaskkillLauncher = launchSystemTaskkill

// Keyed by handle, not pid: a reused pid must never join another tree's kill.
const treeKills = new WeakMap<ChildProcess, WindowsTreeKill>()

export function trackedWindowsTreeKill(child: ChildProcess): WindowsTreeKill | undefined {
  const kill = treeKills.get(child)
  return kill && kill.verdict() !== 'unverifiable' ? kill : undefined
}

export function inFlightWindowsTreeKill(
  child: ChildProcess
): Promise<SettledWindowsTreeKillVerdict> | undefined {
  const kill = treeKills.get(child)
  return kill?.verdict() === 'live' ? kill.settled : undefined
}

/** Delay the root fallback until taskkill fails or its deadline expires. */
export function startWindowsTreeKill(
  child: ChildProcess,
  rootPid: number,
  killRoot: () => void
): WindowsTreeKill {
  const existing = trackedWindowsTreeKill(child)
  if (existing) {
    return existing
  }
  let verdict: WindowsTreeKillVerdict = 'live'
  let resolveSettled: (verdict: SettledWindowsTreeKillVerdict) => void = () => {}
  const settled = new Promise<SettledWindowsTreeKillVerdict>((resolve) => {
    resolveSettled = resolve
  })
  const kill: WindowsTreeKill = { verdict: () => verdict, settled }
  treeKills.set(child, kill)
  let killer: ChildProcess | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let afterRootExit: ReturnType<typeof setTimeout> | undefined
  const abandon = (): void => {
    try {
      killer?.kill()
    } catch {
      /* already gone */
    }
    finish('unverifiable')
  }
  const onRootExit = (): void => {
    afterRootExit ??= setTimeout(abandon, WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS)
    afterRootExit.unref?.()
  }
  function finish(next: SettledWindowsTreeKillVerdict): void {
    if (verdict !== 'live') {
      return
    }
    verdict = next
    clearTimeout(deadline)
    clearTimeout(afterRootExit)
    child.off('exit', onRootExit)
    if (next === 'unverifiable') {
      killRoot()
    }
    resolveSettled(next)
  }
  try {
    killer = launchTaskkill(rootPid)
  } catch {
    finish('unverifiable')
    return kill
  }
  if (process.platform === 'win32' && killer.pid !== undefined) {
    try {
      // Tree termination must not inherit a background caller's scheduling penalty.
      if (getPriority(killer.pid) > constants.priority.PRIORITY_NORMAL) {
        setPriority(killer.pid, constants.priority.PRIORITY_NORMAL)
      }
    } catch {
      /* Priority changes are best effort; keep tracking the original termination. */
    }
  }
  killer.once('error', () => finish('unverifiable'))
  killer.once('close', (code) => finish(code === 0 ? 'exited' : 'unverifiable'))
  deadline = setTimeout(abandon, WINDOWS_TASKKILL_DEADLINE_MS)
  deadline.unref?.()
  child.once('exit', onRootExit)
  if (childProcessExited(child)) {
    onRootExit()
  }
  return kill
}

/** The tracked kill continues even if this caller stops waiting. */
export function waitForWindowsTreeKill(
  kill: WindowsTreeKill,
  waitMs = WINDOWS_TASKKILL_WAIT_MS
): Promise<boolean> {
  if (kill.verdict() !== 'live') {
    return Promise.resolve(kill.verdict() === 'exited')
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs)
    timer.unref?.()
    void kill.settled.then((verdict) => {
      clearTimeout(timer)
      resolve(verdict === 'exited')
    })
  })
}

function childProcessExited(child: ChildProcess): boolean {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

/** Simulates taskkill delays seen on loaded Windows hosts. */
export function _setWindowsTaskkillLauncherForTests(launcher: TaskkillLauncher | null): void {
  launchTaskkill = launcher ?? launchSystemTaskkill
}
