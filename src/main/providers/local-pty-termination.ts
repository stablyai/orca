import type * as pty from 'node-pty'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import { killWithDescendantSweep } from '../pty-descendant-termination'
import { forceKillPosixPtyProcessGroups } from '../pty/posix-pty-process-groups'
import { terminatePtyJob } from '../windows/windows-pty-job'
import {
  clearLocalPtyForceKillTimer,
  clearPtyState,
  disposePtyExitListener,
  disposePtyListeners,
  ptyAgentSessionIds,
  ptyForceKillTimers,
  ptyPhysicalExits,
  ptyProcesses,
  ptyShutdownOperations,
  ptyTerminationMode,
  ptyLoadGeneration,
  runPtyCleanup,
  type PtyShutdownOperation
} from './local-pty-provider-state'
import {
  cancelAllPendingLocalPtySpawns,
  cancelPendingLocalPtySpawns
} from './local-pty-spawn-state'

export const LOCAL_PTY_PHYSICAL_EXIT_TIMEOUT_MS = 8_000
export const LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS = 5_000
export const LOCAL_PTY_FORCE_KILL_RETRY_MS = 250

export function createPtyPhysicalExit(id: string): void {
  ptyPhysicalExits.set(id, new PhysicalExitTracker())
}

function waitForPtyPhysicalExit(id: string, physicalExit?: PhysicalExitTracker): Promise<void> {
  if (!physicalExit) {
    return Promise.reject(new Error(`PTY "${id}" exit tracking unavailable`))
  }
  return physicalExit.waitForExit(
    LOCAL_PTY_PHYSICAL_EXIT_TIMEOUT_MS,
    () => new Error(`Timed out waiting for PTY process exit: ${id}`)
  )
}

function killLocalPtyProcess(proc: pty.IPty, immediate: boolean): void {
  if (process.platform === 'win32') {
    proc.kill()
    return
  }
  if (!immediate) {
    proc.kill('SIGTERM')
    return
  }
  forceKillPosixPtyProcessGroups(proc.pid, () => proc.kill('SIGKILL'))
}

function armLocalPtyForceKill(
  id: string,
  proc: pty.IPty,
  options: { delayMs?: number; attemptsRemaining?: number } = {}
): void {
  if (ptyProcesses.get(id) !== proc || ptyTerminationMode.get(id) !== 'graceful') {
    return
  }
  const attemptsRemaining = options.attemptsRemaining ?? 2
  const timer = setTimeout(() => {
    ptyForceKillTimers.delete(id)
    if (ptyProcesses.get(id) !== proc || ptyTerminationMode.get(id) !== 'graceful') {
      return
    }
    ptyTerminationMode.set(id, 'force')
    try {
      killLocalPtyProcess(proc, true)
    } catch (error) {
      ptyTerminationMode.set(id, 'graceful')
      console.error('[pty] failed to force-kill PTY after graceful deadline', { id, error })
      // Why: a transient native rejection must not consume the only SIGKILL owner while shutdown still awaits physical exit.
      if (attemptsRemaining > 1) {
        armLocalPtyForceKill(id, proc, {
          delayMs: LOCAL_PTY_FORCE_KILL_RETRY_MS,
          attemptsRemaining: attemptsRemaining - 1
        })
      }
    }
  }, options.delayMs ?? LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS)
  timer.unref?.()
  ptyForceKillTimers.set(id, timer)
}

/**
 * Disposes the native PTY handle while avoiding recycled-pid signals on POSIX.
 */
export function destroyPtyProcess(proc: pty.IPty, options: { alreadyKilled?: boolean } = {}): void {
  // Why: neutralize proc.kill before destroy(), whose close-listener SIGHUPs a possibly-recycled POSIX pid; destroy() frees the ptmx fd (docs/fix-pty-fd-leak.md); on Windows destroy() is itself kill().
  if (process.platform === 'win32' && options.alreadyKilled) {
    return
  }
  if (process.platform !== 'win32') {
    ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
  }
  try {
    ;(proc as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow — already torn down */
  }
}

/**
 * Requests local PTY termination while retaining physical-exit ownership.
 */
function requestPtyTermination(id: string, proc: pty.IPty): void {
  runPtyCleanup(id)
  disposePtyListeners(id)
  const previousMode = ptyTerminationMode.get(id)
  // Why: cleanup neutralizes proc.kill below, so escalate an outstanding graceful request before its deadline is disabled.
  if (previousMode !== 'force') {
    clearLocalPtyForceKillTimer(id)
    ptyTerminationMode.set(id, 'force')
    try {
      killLocalPtyProcess(proc, true)
    } catch {
      if (previousMode === 'graceful') {
        ptyTerminationMode.set(id, previousMode)
        armLocalPtyForceKill(id, proc, {
          delayMs: LOCAL_PTY_FORCE_KILL_RETRY_MS,
          attemptsRemaining: 1
        })
      } else {
        ptyTerminationMode.delete(id)
      }
      /* Process may already be dead. */
      return
    }
  }
  // Why: shutdown and orphan cleanup can race; keep onExit + tracker installed until the OS proves the child was reaped.
  destroyPtyProcess(proc, { alreadyKilled: true })
}

function requestTrackedPtyShutdown(id: string, proc: pty.IPty, immediate: boolean): void {
  const previousMode = ptyTerminationMode.get(id)
  // Why: ConPTY has no graceful signal — its first bare kill closes the pseudoconsole, so treat it as a final force request.
  const requestedMode = immediate || process.platform === 'win32' ? 'force' : 'graceful'
  if (!previousMode || (requestedMode === 'force' && previousMode !== 'force')) {
    ptyTerminationMode.set(id, requestedMode)
    try {
      killLocalPtyProcess(proc, immediate)
      if (requestedMode === 'graceful') {
        armLocalPtyForceKill(id, proc)
      } else {
        clearLocalPtyForceKillTimer(id)
      }
    } catch (error) {
      if (previousMode) {
        ptyTerminationMode.set(id, previousMode)
      } else {
        ptyTerminationMode.delete(id)
      }
      throw error
    }
  }
}

async function shutdownTrackedPty(
  id: string,
  proc: pty.IPty,
  operation: PtyShutdownOperation
): Promise<void> {
  const physicalExit = ptyPhysicalExits.get(id)
  const signalRoot = (): void => {
    // Why: natural exit can race the sweep — never signal after this PTY loses ownership.
    if (ptyProcesses.get(id) !== proc) {
      return
    }
    // Cancel startup delivery now, but keep the exit listener and ownership maps until node-pty reports physical exit.
    runPtyCleanup(id)
    operation.rootSignalled = true
    requestTrackedPtyShutdown(id, proc, operation.immediate)
  }
  if (ptyAgentSessionIds.has(id)) {
    // Why: POSIX needs a pre-kill descendant snapshot; Windows tree-kills only when the
    // identity probe returns `own` so agent/MCP orphans cannot hold the worktree cwd
    // (#10004). `unknown`/`foreign`/`absent` skip taskkill and rely on root close alone.
    await killWithDescendantSweep(proc.pid, signalRoot, {
      ownsRoot: () => ptyProcesses.get(id) === proc,
      terminateOwnedTree: () => terminatePtyJob(proc)
    })
  } else if (process.platform === 'win32' && operation.immediate) {
    // Why: a plain shell's ConPTY teardown doesn't reap orphaned children (useConptyDll
    // skips the console reap), so a live `pnpm i`/`node` keeps the ConPTY console alive and
    // holds the worktree cwd. Tree kill runs only when the OS identity probe returns `own`;
    // otherwise root close alone, and detached children may block physical stop (#10004).
    await killWithDescendantSweep(proc.pid, signalRoot, {
      ownsRoot: () => ptyProcesses.get(id) === proc,
      terminateOwnedTree: () => terminatePtyJob(proc)
    })
  } else {
    signalRoot()
  }
  await waitForPtyPhysicalExit(id, physicalExit)
}

export async function shutdownLocalPty(
  id: string,
  opts: { immediate?: boolean; keepHistory?: boolean }
): Promise<void> {
  cancelPendingLocalPtySpawns(id)
  const pending = ptyShutdownOperations.get(id)
  if (pending) {
    if (opts.immediate === true) {
      pending.immediate = true
      if (pending.rootSignalled && ptyProcesses.get(id) === pending.proc) {
        requestTrackedPtyShutdown(id, pending.proc, true)
      }
    }
    await pending.promise
    return
  }
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return
  }
  const entry: PtyShutdownOperation = {
    promise: Promise.resolve(),
    immediate: opts.immediate === true,
    rootSignalled: false,
    proc
  }
  entry.promise = shutdownTrackedPty(id, proc, entry)
  ptyShutdownOperations.set(id, entry)
  try {
    await entry.promise
  } finally {
    if (ptyShutdownOperations.get(id) === entry) {
      ptyShutdownOperations.delete(id)
    }
  }
}

export function killOrphanedLocalPtys(currentGeneration: number): { id: string }[] {
  const killed: { id: string }[] = []
  for (const [id, proc] of ptyProcesses) {
    if ((ptyLoadGeneration.get(id) ?? -1) < currentGeneration) {
      requestPtyTermination(id, proc)
      killed.push({ id })
    }
  }
  return killed
}

export function killAllLocalPtys(): void {
  cancelAllPendingLocalPtySpawns()
  for (const [id, proc] of ptyProcesses) {
    runPtyCleanup(id)
    disposePtyListeners(id)
    disposePtyExitListener(id)
    if (!(process.platform === 'win32' && ptyTerminationMode.has(id))) {
      try {
        proc.kill()
      } catch {
        /* Process may already be dead. */
      }
    }
    // Why: app quit can't retain NAPI callbacks into FreeEnvironment; process exit is the final handle boundary here.
    destroyPtyProcess(proc, { alreadyKilled: true })
    // Why: app quit replaces node-pty's onExit as final owner; overlapping shutdown waiters must join this boundary.
    ptyPhysicalExits.get(id)?.markExited()
    clearPtyState(id)
  }
}
