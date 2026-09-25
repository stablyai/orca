import { constants } from 'node:os'
import type { WindowsBunPtyJob } from './windows-bun-pty-job'
import {
  isPosixPtyRootStopped,
  readPosixPtyProcessTable,
  signalPosixPtyProcessGroups
} from '../../pty/posix-pty-process-groups'

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
  let groupResumeRequired = false
  const signalRoot = (signal: 'SIGSTOP' | 'SIGCONT'): void => {
    // The runtime's named STOP/CONT signals are not portable across POSIX platforms.
    options.processHandle.kill(constants.signals[signal])
  }

  const signalProcessGroup = (
    signal: 'SIGSTOP' | 'SIGCONT',
    table?: string,
    requireGroups = false
  ): void => {
    let resumeFailed = false
    signalPosixPtyProcessGroups(
      options.processHandle.pid,
      signal,
      () => {
        if (requireGroups) {
          throw new Error('Paused PTY group ownership is unavailable')
        }
        signalRoot(signal)
      },
      {
        platform: options.platform,
        ...(table !== undefined
          ? { readProcessTable: () => table }
          : options.readProcessTable
            ? { readProcessTable: options.readProcessTable }
            : {}),
        signalProcessGroup(pgid) {
          // Keep the shell stopped until every preceding job group has resumed.
          if (signal === 'SIGCONT' && requireGroups && resumeFailed) {
            throw new Error('An earlier PTY group could not be resumed')
          }
          try {
            if (options.signalProcessGroup) {
              options.signalProcessGroup(pgid, signal)
            } else {
              process.kill(-pgid, signal)
            }
          } catch (error) {
            resumeFailed = !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
            throw error
          }
          if (signal === 'SIGSTOP') {
            groupResumeRequired = true
          }
        }
      }
    )
  }

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
    if (pauseRequested && state === 'running') {
      try {
        signalRoot('SIGSTOP')
        state = 'uncertain'
      } catch {
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
          signalProcessGroup('SIGSTOP', table, true)
        } else if (groupResumeRequired) {
          signalProcessGroup('SIGCONT', table, true)
        } else {
          signalRoot('SIGCONT')
        }
        state = nextPaused ? 'paused' : 'running'
        if (!nextPaused) {
          groupResumeRequired = false
        }
      })
      .catch(() => {
        retryTransition()
      })
  }

  return {
    pause() {
      if (shuttingDown || options.isExited()) {
        return
      }
      clearTransitionRetry()
      if (options.platform === 'win32') {
        if (state !== 'paused' && options.windowsJob?.pause()) {
          state = 'paused'
        }
        return
      }
      pauseRequested = true
      reconcile()
    },
    resume() {
      clearTransitionRetry()
      if (options.platform === 'win32') {
        if (!options.isExited() && options.windowsJob?.resume()) {
          state = 'running'
        }
        return
      }
      pauseRequested = false
      reconcile()
    },
    resumeForShutdown() {
      clearTransitionRetry()
      if (options.platform === 'win32') {
        if (!options.isExited()) {
          options.windowsJob?.resume()
        }
        state = 'running'
        return
      }
      shuttingDown = true
      pendingRead?.abort()
      try {
        if (!options.isExited() && state !== 'running') {
          // Teardown must release stopped jobs before the root receives its exit signal.
          if (groupResumeRequired) {
            signalProcessGroup('SIGCONT')
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
