import type * as pty from 'node-pty'
import type { RecognizedAgentProcess } from '../../../shared/agent-process-recognition'
import { readPtySlavePath } from '../../../shared/pty-slave-line-discipline-echo'
import {
  forceKillPosixPtyProcessGroups,
  readPosixProcessGroupsOnTerminal,
  signalPosixPtyProcessGroups
} from '../../pty/posix-pty-process-groups'
import { signalPosixPtyForegroundGroup } from '../../pty/posix-pty-foreground-group'
import { readPtsName } from '../../pty/node-pty-pts-name'
import { recordSelfInitiatedTreeKill } from '../../crash-reporting/self-initiated-tree-kill-log'
import { terminatePtyJob } from '../../windows/windows-pty-job'
import { isValidPtySize } from '../daemon-pty-size'
import type { SubprocessHandle } from '../session-subprocess-handle'
import { createPtyForegroundProcessTracker } from './foreground-process-tracker'
import { PtyPreListenerEvents } from './pre-listener-events'
import { ptyProcessNameIsSpawnFile } from './spawn-file-foreground-process'
import { inspectSpawnFileWindowsChildProcesses } from './spawn-file-child-processes'

type DisposableNativePty = pty.IPty & {
  destroy?: () => void
  signalProcess?: (signal: string) => void
}

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
  const reportsChildExitStatus = args.reportsChildExitStatus
  const proc = args.process
  // node-pty exposes destroy at runtime but omits it from IPty.
  const nativeProc: DisposableNativePty = proc
  const events = new PtyPreListenerEvents()
  let dead = false
  // I/O failure is not exit evidence; keep termination and producer flow control available.
  let ioFailed = false
  let disposed = false
  let nodePtyKillIssued = false
  // Groups learned while the root pid still owned the PTY. Exit sets `dead`
  // before listeners run, so a later SIGKILL cannot look that pid up again.
  let rememberedProcessGroups: number[] | null = null
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
    // Exit listeners may re-enter cleanup; retire signal authority before notifying them.
    dead = true
    foreground.markDead()
    // Why: neutralize kill synchronously so a later async socket-close SIGHUP cannot hit a recycled pid.
    if (process.platform !== 'win32') {
      nativeProc.kill = () => {}
    }
    events.acceptExit({
      exitCode,
      signal,
      hostReportsChildExitStatus: reportsChildExitStatus
    })
  })

  const slavePath = readPtySlavePath(proc)
  const signalRememberedProcessGroups = (signal: NodeJS.Signals): void => {
    const groups = rememberedProcessGroups
    // A group id remembered at SIGTERM can be reused after the root exits.
    // Signal it only when a fresh table still shows that id on this PTY.
    const stillAttached = slavePath ? readPosixProcessGroupsOnTerminal(slavePath) : null
    if (!groups || !stillAttached) {
      return
    }
    const allowed = new Set(stillAttached)
    for (const pgid of groups) {
      if (!allowed.has(pgid)) {
        continue
      }
      try {
        process.kill(-pgid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') {
          continue
        }
        throw error
      }
      if (signal === 'SIGKILL') {
        recordSelfInitiatedTreeKill({
          pid: pgid,
          site: 'posix-pty-process-group-sweep',
          scope: 'posix-process-group'
        })
      }
    }
  }
  return {
    pid: proc.pid,
    processNameIsSpawnFile: ptyProcessNameIsSpawnFile(proc),
    ...(process.platform === 'win32'
      ? { inspectChildProcesses: () => inspectSpawnFileWindowsChildProcesses(proc) }
      : {}),
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
      if (dead || ioFailed) {
        return
      }
      try {
        proc.write(data)
      } catch {
        ioFailed = true
      }
    },
    resize: (cols, rows) => {
      if (dead || ioFailed || !isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        ioFailed = true
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
      if (dead || ioFailed) {
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
      if (nativeProc.signalProcess) {
        try {
          nativeProc.signalProcess(sig)
        } catch {
          /* The process may have exited. */
        }
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
    signalProcessGroups: (signal) => {
      if (process.platform === 'win32') {
        // ConPTY has no POSIX process groups. forceKill still owns that tree.
        return
      }
      if (dead) {
        signalRememberedProcessGroups(signal)
        return
      }
      const captured: number[] = []
      try {
        signalPosixPtyProcessGroups(
          proc.pid,
          signal,
          () => {
            process.kill(proc.pid, signal)
          },
          {
            signalProcessGroup: (pgid) => {
              process.kill(-pgid, signal)
              captured.push(pgid)
            }
          }
        )
      } finally {
        if (captured.length > 0) {
          rememberedProcessGroups = captured
        }
      }
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
