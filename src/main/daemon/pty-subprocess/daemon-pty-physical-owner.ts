import type { DisposableNativePty } from './native-pty-spawn'
import type * as pty from 'node-pty'
import { forceKillPosixPtyProcessGroups } from '../../pty/posix-pty-process-groups'
import { PendingPtyGroupSweep } from '../../pty/pending-pty-group-sweep'
import { killConptyNow, terminatePtyJob } from '../../windows/windows-pty-job'
import { SessionTerminationController } from '../session-termination-controller'
import { shutdownOwnedTerminalProcess } from '../terminal-host-session-shutdown'
import { createGitBashConsoleCapacityDetector } from '../../../shared/git-bash-console-capacity'
import { resolvePtyOwnerBackend } from '../../../shared/pty-owner-backend'
import { resolveProcessExitCause } from '../../../shared/terminal-exit-cause'
import { withInitialOutputDiagnostic } from '../../../shared/terminal-start-failure'

export function createDaemonPtyPhysicalOwner(proc: pty.IPty, shellPath: string) {
  const nativeProc: DisposableNativePty = proc
  const initialOutput =
    resolvePtyOwnerBackend({ platform: process.platform, shellPath }) === 'windows-conpty'
      ? createGitBashConsoleCapacityDetector(4096)
      : null
  let nativeDataSubscription: pty.IDisposable | undefined
  let exit: { exitCode: number; signal?: number } | null = null
  const exitListeners = new Set<Parameters<pty.IPty['onExit']>[0]>()
  let disposed = false
  let nodePtyKillIssued = false
  const groupSweep = new PendingPtyGroupSweep()
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
    if (exit) {
      return
    }
    // A reaped root frees its pid and TTY for reuse, so a table read that outlives it signals nothing.
    await groupSweep.track(
      forceKillPosixPtyProcessGroups(proc.pid, killRoot, { ownsRoot: () => exit === null }).catch(
        fallBackToNodePtyKill
      )
    )
  }
  const kill = (): void => {
    if (exit || (process.platform === 'win32' && nodePtyKillIssued)) {
      return
    }
    if (process.platform === 'win32' && killConptyNow(proc)) {
      nodePtyKillIssued = true
      return
    }
    nodePtyKillIssued = true
    try {
      proc.kill()
    } catch (error) {
      nodePtyKillIssued = false
      throw error
    }
  }
  const forceKillConpty = (): void => {
    if (exit) {
      return
    }
    // Re-request the owned job even after a native close; neither request proves exit.
    terminatePtyJob(proc)
    kill()
  }

  const forceKill = () => (process.platform === 'win32' ? forceKillConpty() : forceKillPosix())
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    nativeDataSubscription?.dispose()
    nativeDataSubscription = undefined
    const destroy = (): void => {
      try {
        nativeProc.destroy?.()
      } catch {}
    }
    if (process.platform !== 'win32') {
      nativeProc.kill = () => {}
    } else if (nodePtyKillIssued) {
      return
    }
    groupSweep.afterSettled(destroy)
  }
  const termination = new SessionTerminationController({
    sessionId: String(proc.pid),
    subprocess: { kill, forceKill, signal: (signal) => proc.kill(signal), dispose },
    isExited: () => exit !== null,
    releaseProducerPause: ({ resume }) => {
      if (resume) {
        proc.resume()
      }
    }
  })
  let nativeExitSubscription: pty.IDisposable | undefined
  const retireNativeExitSubscription = (): void => {
    const subscription = nativeExitSubscription
    nativeExitSubscription = undefined
    subscription?.dispose()
  }
  const observeExit = (): void => {
    if (exit || nativeExitSubscription) {
      return
    }
    // Observe the original prefix before ConPTY rewrites or pre-listener eviction.
    if (initialOutput && !nativeDataSubscription) {
      nativeDataSubscription = proc.onData(initialOutput.observe)
    }
    nativeExitSubscription = proc.onExit((event) => {
      if (exit) {
        return
      }
      exit = {
        exitCode: event.exitCode,
        ...(event.signal !== undefined ? { signal: event.signal } : {})
      }
      termination.markPhysicalExit()
      const errors: unknown[] = []
      try {
        nativeDataSubscription?.dispose()
        nativeDataSubscription = undefined
      } catch (error) {
        errors.push(error)
      }
      try {
        retireNativeExitSubscription()
      } catch (error) {
        errors.push(error)
      }
      try {
        const listeners = [...exitListeners]
        for (const listener of listeners) {
          if (exitListeners.delete(listener)) {
            try {
              listener(exit)
            } catch (error) {
              errors.push(error)
            }
          }
        }
      } finally {
        exitListeners.clear()
      }
      if (errors.length > 0) {
        throw errors[0]
      }
    })
    if (exit) {
      retireNativeExitSubscription()
    }
  }
  return {
    observeExit,
    resolveExitCause: (observation: Parameters<typeof resolveProcessExitCause>[0]) =>
      withInitialOutputDiagnostic(
        resolveProcessExitCause(observation),
        initialOutput?.detected() === true
      ),
    completion: termination.physicalCompletion,
    exitCode: () => exit?.exitCode ?? null,
    onExit: (listener: Parameters<pty.IPty['onExit']>[0]): pty.IDisposable => {
      if (exit) {
        listener(exit)
      } else {
        exitListeners.add(listener)
      }
      return {
        dispose: () => {
          exitListeners.delete(listener)
        }
      }
    },
    hasExited: () => exit !== null,
    kill,
    forceKill,
    dispose,
    recover: () => {
      try {
        observeExit()
      } catch {
        // Observation failure must not revoke the returned process's cleanup authority.
      }
      return shutdownOwnedTerminalProcess({
        pid: proc.pid,
        isAlive: () => exit === null,
        terminateOwnedTree: () => terminatePtyJob(proc),
        close: async () => {
          await termination.forceKillAndWaitForExit()
          dispose()
        }
      })
    }
  }
}
