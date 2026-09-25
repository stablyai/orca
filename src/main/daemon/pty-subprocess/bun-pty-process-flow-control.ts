import { constants } from 'node:os'
import type { WindowsBunPtyJob } from './windows-bun-pty-job'
import { isPosixPtyRootStopped, readPosixPtyProcessTable } from '../../pty/posix-pty-process-groups'

import { createBunPtyProcessSuspension } from './bun-pty-process-suspension'

const TRANSITION_RETRY_MS = 500

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
  let state: 'running' | 'paused' | 'uncertain' = 'running'
  let pauseRequested = false
  let shuttingDown = false
  let pendingRead: AbortController | undefined
  let transitionRetry: ReturnType<typeof setTimeout> | undefined
  let pauseDenied = false
  const signalRoot = (signal: 'SIGSTOP' | 'SIGCONT'): void => {
    // The runtime's named STOP/CONT signals are not portable across POSIX platforms.
    options.processHandle.kill(constants.signals[signal])
  }

  const suspension = createBunPtyProcessSuspension({
    pid: options.processHandle.pid,
    platform: options.platform,
    signalRoot,
    readProcessTable: options.readProcessTable,
    signalProcessGroup: options.signalProcessGroup
  })
  const pausePermanentlyDenied = (error: unknown): boolean =>
    error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')

  const clearTransitionRetry = (): void => {
    clearTimeout(transitionRetry)
    transitionRetry = undefined
  }

  const retryTransition = (): void => {
    if (
      shuttingDown ||
      options.isExited() ||
      state === (pauseRequested ? 'paused' : 'running') ||
      transitionRetry
    ) {
      return
    }
    // Callers send transitions once; retain the obligation until fresh ownership confirms every group.
    transitionRetry = setTimeout(() => {
      transitionRetry = undefined
      reconcile()
    }, TRANSITION_RETRY_MS)
    transitionRetry.unref?.()
  }

  const reconcile = (): void => {
    if (
      shuttingDown ||
      options.isExited() ||
      state === (pauseRequested ? 'paused' : 'running') ||
      pendingRead
    ) {
      return
    }
    if (options.platform === 'win32') {
      const succeeded = pauseRequested ? options.windowsJob?.pause() : options.windowsJob?.resume()
      state = succeeded ? (pauseRequested ? 'paused' : 'running') : 'uncertain'
      if (pauseRequested && !succeeded) {
        pauseRequested = false
      }
      retryTransition()
      return
    }
    if (pauseRequested && state === 'running') {
      try {
        signalRoot('SIGSTOP')
        state = 'uncertain'
      } catch (error) {
        if (pausePermanentlyDenied(error)) {
          pauseDenied = true
          pauseRequested = false
        }
        retryTransition()
        return
      }
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
        if (
          shuttingDown ||
          options.isExited() ||
          state === (pauseRequested ? 'paused' : 'running')
        ) {
          return
        }
        const nextPaused = pauseRequested
        // Partial signals require a fresh transition even if the requested state changes again.
        state = 'uncertain'
        if (nextPaused) {
          // Signal delivery is asynchronous; prove the shell stopped before suspending its jobs.
          if (!isPosixPtyRootStopped(table, options.processHandle.pid)) {
            retryTransition()
            return
          }
          suspension.signal('SIGSTOP', table, true)
        } else if (suspension.hasStoppedGroups()) {
          suspension.signal('SIGCONT', table, true)
        } else {
          signalRoot('SIGCONT')
        }
        state = nextPaused ? 'paused' : 'running'
      })
      .catch((error) => {
        if (pauseRequested && pausePermanentlyDenied(error)) {
          pauseDenied = true
          pauseRequested = false
          reconcile()
        } else {
          retryTransition()
        }
      })
  }

  return {
    pause() {
      if (shuttingDown || options.isExited() || pauseDenied) {
        return
      }
      clearTransitionRetry()
      pauseRequested = true
      reconcile()
    },
    resume() {
      clearTransitionRetry()
      pauseDenied = false
      pauseRequested = false
      reconcile()
    },
    resumeForShutdown() {
      clearTransitionRetry()
      shuttingDown = true
      if (options.platform === 'win32') {
        if (!options.isExited()) {
          options.windowsJob?.resume()
        }
        state = 'running'
        return
      }
      pendingRead?.abort()
      try {
        if (!options.isExited() && state !== 'running') {
          // Teardown must release stopped jobs before the root receives its exit signal.
          if (suspension.hasStoppedGroups()) {
            suspension.signal('SIGCONT')
          } else {
            signalRoot('SIGCONT')
          }
        }
      } catch {
        // A failed resume must not prevent the caller from terminating the PTY.
      }
      state = 'running'
    }
  }
}
