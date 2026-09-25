import type { WindowsBunPtyJob } from './windows-bun-pty-job'
import {
  readPosixPtyProcessTable,
  signalPosixPtyProcessGroups
} from '../../pty/posix-pty-process-groups'

type BunPtyProcessHandle = Readonly<{
  pid: number
  kill(signal?: string | number): void
  terminal: Readonly<{ closed: boolean; close(): void }>
}>

export type BunPtyProducerFlowControl = Readonly<{
  pause(): void
  resume(): void
  resumeForShutdown(): void
}>

export function createBunPtyProducerFlowControl(
  options: Readonly<{
    platform: NodeJS.Platform
    processHandle: BunPtyProcessHandle
    windowsJob: WindowsBunPtyJob | null
    isExited: () => boolean
    readProcessTable?: () => string
    readProcessTableAsync?: (signal: AbortSignal) => Promise<string>
    signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
  }>
): BunPtyProducerFlowControl {
  let paused = false
  let pauseRequested = false
  let shuttingDown = false
  let pendingRead: AbortController | undefined

  const signalProcessGroup = (signal: 'SIGSTOP' | 'SIGCONT', table?: string): void => {
    signalPosixPtyProcessGroups(
      options.processHandle.pid,
      signal,
      () => {
        options.processHandle.kill(signal)
      },
      {
        platform: options.platform,
        ...(table !== undefined
          ? { readProcessTable: () => table }
          : options.readProcessTable
            ? { readProcessTable: options.readProcessTable }
            : {}),
        ...(options.signalProcessGroup
          ? { signalProcessGroup: (pgid: number) => options.signalProcessGroup?.(pgid, signal) }
          : {})
      }
    )
  }

  const reconcile = (): void => {
    if (shuttingDown || options.isExited() || pauseRequested === paused || pendingRead) {
      return
    }
    const controller = new AbortController()
    pendingRead = controller
    // Process groups change as the shell runs jobs; revalidate them without blocking PTY output.
    void Promise.resolve()
      .then(() =>
        options.readProcessTableAsync
          ? options.readProcessTableAsync(controller.signal)
          : options.readProcessTable
            ? options.readProcessTable()
            : readPosixPtyProcessTable(options.processHandle.pid, controller.signal)
      )
      .catch(() => '')
      .then((table) => {
        pendingRead = undefined
        if (shuttingDown || options.isExited() || pauseRequested === paused) {
          return
        }
        const nextPaused = pauseRequested
        // A partially successful stop still needs a later resume.
        if (nextPaused) {
          paused = true
        }
        signalProcessGroup(nextPaused ? 'SIGSTOP' : 'SIGCONT', table)
        paused = nextPaused
      })
      .catch(() => {
        // PTY ownership can disappear during a scan; flow control is best-effort.
      })
  }

  return {
    pause() {
      if (shuttingDown || options.isExited()) {
        return
      }
      if (options.platform === 'win32') {
        if (!paused && options.windowsJob?.pause()) {
          paused = true
        }
        return
      }
      pauseRequested = true
      reconcile()
    },
    resume() {
      if (options.platform === 'win32') {
        if (!options.isExited() && options.windowsJob?.resume()) {
          paused = false
        }
        return
      }
      pauseRequested = false
      reconcile()
    },
    resumeForShutdown() {
      if (options.platform === 'win32') {
        options.windowsJob?.resume()
        paused = false
        return
      }
      shuttingDown = true
      pendingRead?.abort()
      try {
        if (!options.isExited() && paused) {
          // Teardown must release stopped jobs before the root receives its exit signal.
          signalProcessGroup('SIGCONT')
        }
      } catch {
        // A failed resume must not prevent the caller from terminating the PTY.
      }
      paused = false
    }
  }
}
