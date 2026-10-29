import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudePeerIdentityReader } from '../../claude/claude-peer-identity'
import type * as pty from 'node-pty'
import type { RecognizedAgentProcess } from '../../../shared/agent-process-recognition'
import { readPtySlavePath } from '../../../shared/pty-slave-line-discipline-echo'
import { forceKillPosixPtyProcessGroups } from '../../pty/posix-pty-process-groups'
import { signalPosixPtyForegroundGroup } from '../../pty/posix-pty-foreground-group'
import { PendingPtyGroupSweep } from '../../pty/pending-pty-group-sweep'
import { readPtsName } from '../../pty/node-pty-pts-name'
import { terminatePtyJob } from '../../windows/windows-pty-job'
import { isValidPtySize } from '../daemon-pty-size'
import type { SubprocessHandle } from '../session-subprocess-handle'
import { createPtyForegroundProcessTracker } from './foreground-process-tracker'
import { PtyPreListenerEvents } from './pre-listener-events'
import { ptyProcessNameIsSpawnFile } from './spawn-file-foreground-process'
import { inspectSpawnFileWindowsChildProcesses } from './spawn-file-child-processes'
import type { ConptyStartupEvents } from './conpty-startup-input-reader'

type DisposableNativePty = pty.IPty & {
  destroy?: () => void
  signalProcess?: (signal: string) => void
  // node-pty emits these when its master stream retires; writes then become silent no-ops.
  on?: (event: 'close' | 'error', listener: (error?: unknown) => void) => void
  // False once node-pty's _close() retired the master; Windows never emits 'close' for that.
  _writable?: boolean
}

// Normal exit also retires the master first; let the exit report win before calling input closed.
export const MASTER_CLOSE_EXIT_GRACE_MS = 1_000

export function createDaemonPtySubprocessHandle(args: {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  env: Record<string, string>
  startupCommandDeliveredInShellArgs: boolean
  reportsChildExitStatus: boolean
  requestedCwd?: string
  sessionId: string
  startupAgentRecognition: RecognizedAgentProcess | null
  /** Output and exit buffered before this handle subscribed; replayed ahead of live events. */
  startupEvents?: ConptyStartupEvents
}): SubprocessHandle {
  const peerIdentity = new ClaudePeerIdentityReader(
    args.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  )
  const reportsChildExitStatus = args.reportsChildExitStatus
  const shellPath = args.shellPath
  const proc = args.process
  // node-pty exposes destroy at runtime but omits it from IPty.
  const nativeProc: DisposableNativePty = proc
  const events = new PtyPreListenerEvents()
  let dead = false
  // Unlike dead, disposal keeps this false so an in-flight force-kill still lands.
  let exited = false
  const groupSweep = new PendingPtyGroupSweep()
  // I/O failure is not exit evidence; keep termination and producer flow control available.
  let ioFailed = false
  let disposed = false
  let nodePtyKillIssued = false
  let masterRetired = false
  let masterError: string | null = null
  let masterRetiredTimer: ReturnType<typeof setTimeout> | null = null
  let inputClosedNotified = false
  let inputClosedListener: ((reason: string) => void) | null = null
  const notifyInputClosed = (reason: string): void => {
    if (dead || inputClosedNotified) {
      return
    }
    inputClosedNotified = true
    inputClosedListener?.(reason)
  }
  const failIo = (operation: 'write' | 'resize'): void => {
    ioFailed = true
    notifyInputClosed(`${operation}_failed`)
  }
  const clearMasterRetiredTimer = (): void => {
    if (masterRetiredTimer) {
      clearTimeout(masterRetiredTimer)
      masterRetiredTimer = null
    }
  }
  const foreground = createPtyForegroundProcessTracker({
    process: proc,
    shellPath: args.shellPath,
    cwd: args.requestedCwd,
    sessionId: args.sessionId,
    startupAgentRecognition: args.startupAgentRecognition,
    isDead: () => dead
  })

  const acceptData = (data: string): void => {
    foreground.recordOutput(data)
    events.acceptData(data)
  }
  args.startupEvents?.data.forEach(acceptData)
  proc.onData(acceptData)
  const retireMaster = (): void => {
    masterRetired = true
    if (dead || masterRetiredTimer) {
      return
    }
    masterRetiredTimer = setTimeout(() => {
      masterRetiredTimer = null
      notifyInputClosed(masterError ? `master_closed: ${masterError}` : 'master_closed')
    }, MASTER_CLOSE_EXIT_GRACE_MS)
    masterRetiredTimer.unref?.()
  }
  nativeProc.on?.('error', (error) => {
    // node-pty's own handler ran first; only errors that retired the master are input loss.
    if (nativeProc._writable === false) {
      masterError = error instanceof Error ? error.message : String(error)
      retireMaster()
    }
  })
  nativeProc.on?.('close', retireMaster)
  // node-pty may have retired its master while Windows startup was confirmed, before these listeners.
  if (args.startupEvents && nativeProc._writable === false) {
    retireMaster()
  }
  const acceptExit = ({ exitCode, signal }: { exitCode: number; signal?: number }): void => {
    // Exit listeners may re-enter cleanup; retire signal authority before notifying them.
    dead = true
    exited = true
    clearMasterRetiredTimer()
    foreground.markDead()
    // Neutralize kill before an async socket-close SIGHUP can target a recycled PID.
    if (process.platform !== 'win32') {
      nativeProc.kill = () => {}
    }
    events.acceptExit({
      exitCode,
      signal,
      hostReportsChildExitStatus: reportsChildExitStatus
    })
  }
  if (args.startupEvents?.exit) {
    acceptExit(args.startupEvents.exit)
  } else {
    proc.onExit(acceptExit)
  }

  const killRoot = (): void => {
    process.kill(proc.pid, 'SIGKILL')
  }
  const fallBackToNodePtyKill = (signalError: unknown): void => {
    try {
      proc.kill()
      nodePtyKillIssued = true
    } catch {
      nodePtyKillIssued = false
      throw signalError
    }
  }
  const forceKillPosix = async (): Promise<void> => {
    if (dead) {
      return
    }
    // A reaped root frees its pid and TTY for reuse, so a table read that outlives it signals nothing.
    await groupSweep.track(
      forceKillPosixPtyProcessGroups(proc.pid, killRoot, { ownsRoot: () => !exited }).catch(
        fallBackToNodePtyKill
      )
    )
  }
  // Stays synchronous: dispose() reads nodePtyKillIssued right after to avoid double-closing ConPTY.
  const forceKillConpty = (): void => {
    if (dead) {
      return
    }
    // Escalate a ConPTY kill through the job without double-closing node-pty's shell handle.
    if (nodePtyKillIssued) {
      terminatePtyJob(proc)
      return
    }
    try {
      killRoot()
    } catch (signalError) {
      fallBackToNodePtyKill(signalError)
    }
  }

  const slavePath = readPtySlavePath(proc)
  return {
    pid: proc.pid,
    processNameIsSpawnFile: ptyProcessNameIsSpawnFile(proc),
    // Only the login(1) wrapper hides the shell's exit status, and it forks the shell as its child.
    shellIsRootChild: !reportsChildExitStatus,
    ...(process.platform === 'win32'
      ? {
          inspectChildProcesses: (fresh?: boolean, ignoreDetached?: boolean) =>
            inspectSpawnFileWindowsChildProcesses(proc, shellPath, fresh, ignoreDetached)
        }
      : {}),
    shellPath: args.shellPath,
    shellCwd: args.spawnCwd,
    shellPathEnv: args.env.PATH,
    readClaudePeerIdentity: (processName, pid) =>
      peerIdentity.read(processName, pid ?? foreground.getForegroundProcessId()),
    ...(slavePath ? { slavePath } : {}),
    ...(args.startupCommandDeliveredInShellArgs
      ? { startupCommandDeliveredInShellArgs: true }
      : {}),
    getForegroundProcess: foreground.getForegroundProcess,
    confirmForegroundProcess: foreground.confirmForegroundProcess,
    confirmShellForeground: foreground.confirmShellForeground,
    write: (data) => {
      if (dead || ioFailed || masterRetired) {
        return
      }
      try {
        proc.write(data)
      } catch {
        failIo('write')
      }
    },
    isInputClosed: () => dead || ioFailed || masterRetired,
    onInputClosed: (cb) => {
      inputClosedListener = cb
    },
    resize: (cols, rows) => {
      if (dead || ioFailed || masterRetired || !isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        failIo('resize')
      }
    },
    // WindowsTerminal also wires _socket to the ConPTY conout pipe, so pausing backpressures the child.
    pause: () => {
      if (dead) {
        return
      }
      try {
        proc.pause()
      } catch {}
    },
    resume: () => {
      if (dead) {
        return
      }
      try {
        proc.resume()
      } catch {}
    },
    clear: () => {
      if (dead || ioFailed) {
        return
      }
      try {
        proc.clear()
      } catch {}
    },
    kill: () => {
      if (dead) {
        return
      }
      nodePtyKillIssued = true
      try {
        proc.kill()
      } catch (error) {
        // A rejected native kill is not proof of exit; keep the wrapper live for a retry.
        nodePtyKillIssued = false
        throw error
      }
    },
    terminateOwnedTree: () => terminatePtyJob(proc),
    forceKill: () => (process.platform === 'win32' ? forceKillConpty() : forceKillPosix()),
    signal: (sig) => {
      if (dead) {
        return
      }
      if (nativeProc.signalProcess) {
        try {
          nativeProc.signalProcess(sig)
        } catch {}
        return
      }
      const signalRootPid = (): void => {
        try {
          process.kill(proc.pid, sig)
        } catch {}
      }
      // SIGWINCH belongs to the tty foreground group; destructive signals keep the root-pid target.
      if (sig === 'SIGWINCH') {
        void signalPosixPtyForegroundGroup(proc.pid, readPtsName(proc), sig, signalRootPid, {
          ownsRoot: () => !exited
        })
        return
      }
      signalRootPid()
    },
    onData: (cb) => events.onData(cb),
    onExit: (cb) => events.onExit(cb),
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      dead = true
      clearMasterRetiredTimer()
      inputClosedListener = null
      events.clear()
      const destroy = (): void => {
        try {
          nativeProc.destroy?.()
        } catch {}
      }
      // POSIX destroy() can asynchronously signal a recycled pid; Windows needs kill() to close ConPTY.
      if (process.platform !== 'win32') {
        nativeProc.kill = () => {}
      } else if (nodePtyKillIssued) {
        return
      }
      groupSweep.afterSettled(destroy)
    }
  }
}
