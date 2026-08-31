import type * as pty from 'node-pty'
import type { RecognizedAgentProcess } from '../../../shared/agent-process-recognition'
import { readPtySlavePath } from '../../../shared/pty-slave-line-discipline-echo'
import { forceKillPosixPtyProcessGroups } from '../../pty/posix-pty-process-groups'
import { signalPosixPtyForegroundGroup } from '../../pty/posix-pty-foreground-group'
import { readPtsName } from '../../pty/node-pty-pts-name'
import { terminatePtyJob } from '../../windows/windows-pty-job'
import { isValidPtySize } from '../daemon-pty-size'
import type { SubprocessHandle } from '../session-subprocess-handle'
import { createPtyForegroundProcessTracker } from './foreground-process-tracker'
import { PtyPreListenerEvents } from './pre-listener-events'

type DisposableNativePty = pty.IPty & { destroy?: () => void }

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
}): SubprocessHandle {
  const proc = args.process
  // node-pty exposes destroy at runtime but omits it from IPty.
  const nativeProc = proc as DisposableNativePty
  const events = new PtyPreListenerEvents()
  let dead = false
  let disposed = false
  let nodePtyKillIssued = false
  const foreground = createPtyForegroundProcessTracker({
    process: proc,
    shellPath: args.shellPath,
    cwd: args.requestedCwd,
    sessionId: args.sessionId,
    startupAgentRecognition: args.startupAgentRecognition,
    isDead: () => dead
  })

  proc.onData((data) => {
    foreground.recordOutput(data)
    events.acceptData(data)
  })
  proc.onExit(({ exitCode, signal }) => {
    events.acceptExit({
      exitCode,
      signal,
      hostReportsChildExitStatus: args.reportsChildExitStatus
    })
  })
  proc.onExit(() => {
    dead = true
    foreground.markDead()
    // Why: neutralize kill synchronously so a later async socket-close SIGHUP cannot hit a recycled pid.
    if (process.platform !== 'win32') {
      nativeProc.kill = () => {}
    }
  })

  const slavePath = readPtySlavePath(proc)
  return {
    pid: proc.pid,
    shellPath: args.shellPath,
    shellCwd: args.spawnCwd,
    shellPathEnv: args.env.PATH,
    ...(slavePath ? { slavePath } : {}),
    ...(args.startupCommandDeliveredInShellArgs
      ? { startupCommandDeliveredInShellArgs: true }
      : {}),
    getForegroundProcess: foreground.getForegroundProcess,
    confirmForegroundProcess: foreground.confirmForegroundProcess,
    confirmShellForeground: foreground.confirmShellForeground,
    write: (data) => {
      if (dead) {
        return
      }
      try {
        proc.write(data)
      } catch {
        dead = true
      }
    },
    resize: (cols, rows) => {
      if (dead || !isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        dead = true
      }
    },
    // WindowsTerminal also wires _socket to the ConPTY conout pipe, so pausing backpressures the child.
    pause: () => {
      if (dead) {
        return
      }
      try {
        proc.pause()
      } catch {
        // Native handle already torn down; flow control is best-effort.
      }
    },
    resume: () => {
      if (dead) {
        return
      }
      try {
        proc.resume()
      } catch {
        // Native handle already torn down; flow control is best-effort.
      }
    },
    clear: () => {
      if (dead) {
        return
      }
      try {
        proc.clear()
      } catch {
        // A clear on a just-exited PTY is best-effort.
      }
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
    forceKill: () => {
      if (dead) {
        return
      }
      // Escalate a ConPTY kill through the job without double-closing node-pty's shell handle.
      if (process.platform === 'win32' && nodePtyKillIssued) {
        terminatePtyJob(proc)
        return
      }
      try {
        forceKillPosixPtyProcessGroups(proc.pid, () => {
          process.kill(proc.pid, 'SIGKILL')
        })
      } catch (signalError) {
        try {
          proc.kill()
          nodePtyKillIssued = true
        } catch {
          nodePtyKillIssued = false
          throw signalError
        }
      }
    },
    signal: (sig) => {
      if (dead) {
        return
      }
      const signalRootPid = (): void => {
        try {
          process.kill(proc.pid, sig)
        } catch {
          // Process may already be dead.
        }
      }
      // SIGWINCH belongs to the tty foreground group; destructive signals keep the root-pid target.
      if (sig === 'SIGWINCH') {
        signalPosixPtyForegroundGroup(proc.pid, readPtsName(proc), sig, signalRootPid)
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
      events.clear()
      // POSIX destroy() can asynchronously signal a recycled pid; Windows needs kill() to close ConPTY.
      if (process.platform !== 'win32') {
        nativeProc.kill = () => {}
      } else if (nodePtyKillIssued) {
        return
      }
      try {
        nativeProc.destroy?.()
      } catch {
        // Native handle was already torn down.
      }
    }
  }
}
