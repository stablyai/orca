import { app, type BrowserWindow, type Event } from 'electron'
import { isEphemeralAppImageRuntime } from '../../updater/linux-package/appimage-runtime-identity'
import { mainProcessState } from '../main-process-state'
import { prepareAppImageRelaunch, type PreparedAppRelaunch } from './appimage-relaunch'
import { isHostShuttingDown } from './host-shutdown-state'
import { quitProcess } from './process-quit-request'

type RelaunchAttempt = {
  abort: AbortController
  phase: 'preparing' | 'quitting' | 'committing'
  profileMoveWindow?: Pick<BrowserWindow, 'destroy' | 'isDestroyed'>
  beforeCommit?: () => void
  launcher?: PreparedAppRelaunch
  quitResult?: PromiseWithResolvers<void>
}

let active: RelaunchAttempt | undefined

function cancel(
  attempt: RelaunchAttempt,
  error: unknown = new Error('Orca restart was canceled.')
): void {
  if (active === attempt) {
    active = undefined
  }
  attempt.abort.abort(error)
  attempt.launcher?.cancel()
  attempt.quitResult?.reject(error)
}

export function cancelProcessRelaunch(): void {
  if (
    active &&
    !active.profileMoveWindow &&
    active.phase !== 'committing' &&
    !isHostShuttingDown()
  ) {
    cancel(active)
  }
}

export function skipBeforeQuitForRelaunch(
  event: Pick<Event, 'defaultPrevented' | 'preventDefault'>
): boolean {
  if (
    active?.phase === 'committing' ||
    (active?.phase === 'preparing' && active.profileMoveWindow)
  ) {
    event.preventDefault()
    return true
  }
  if (active?.phase === 'preparing') {
    cancelProcessRelaunch()
  }
  return event.defaultPrevented
}

export type AppImageProcessRelaunch = {
  readonly signal: AbortSignal
  protectProfileMove(window: Pick<BrowserWindow, 'destroy' | 'isDestroyed'>): void
  quit(beforeCommit?: () => void): Promise<void>
  exit(code: number, beforeExit?: () => void | Promise<void>): Promise<void>
  cancel(): void
}

export function prepareProcessRelaunch(
  options?: Electron.RelaunchOptions
): Promise<AppImageProcessRelaunch> | undefined {
  if (!app.isPackaged || options?.execPath !== undefined || !isEphemeralAppImageRuntime()) {
    return undefined
  }
  return prepareAppImageProcessRelaunch(options?.args ?? process.argv.slice(1))
}

async function prepareAppImageProcessRelaunch(args: string[]): Promise<AppImageProcessRelaunch> {
  if (active || mainProcessState.isQuitting || isHostShuttingDown()) {
    throw new Error('Orca is already restarting or quitting.')
  }
  const attempt: RelaunchAttempt = {
    abort: new AbortController(),
    phase: 'preparing'
  }
  active = attempt
  try {
    const launcher = await prepareAppImageRelaunch(args, attempt.abort.signal)
    attempt.launcher = launcher
    attempt.abort.signal.throwIfAborted()
    return {
      signal: attempt.abort.signal,
      protectProfileMove(window) {
        attempt.abort.signal.throwIfAborted()
        attempt.profileMoveWindow = window
      },
      cancel() {
        if (attempt.phase === 'preparing') {
          cancel(attempt)
        }
      },
      async quit(beforeCommit) {
        attempt.abort.signal.throwIfAborted()
        if (attempt.phase !== 'preparing') {
          return attempt.quitResult?.promise
        }
        attempt.phase = 'quitting'
        if (beforeCommit) {
          attempt.beforeCommit = beforeCommit
        }
        const result = Promise.withResolvers<void>()
        attempt.quitResult = result
        // app.quit() emits before-quit synchronously. Window vetoes arrive through onQuitAborted.
        let quitEvent: Event | undefined
        const captureQuitEvent = (event: Event): void => {
          quitEvent = event
        }
        app.prependOnceListener('before-quit', captureQuitEvent)
        try {
          quitProcess()
          if (attempt.profileMoveWindow) {
            // Only the initiating window completed the preload checkpoint for this move.
            if (!attempt.profileMoveWindow.isDestroyed()) {
              attempt.profileMoveWindow.destroy()
            }
            if (!isHostShuttingDown()) {
              quitProcess()
            }
          } else if (!quitEvent || quitEvent.defaultPrevented) {
            mainProcessState.isQuitting = false
            cancel(attempt)
          }
        } catch (error) {
          cancel(attempt, error)
        } finally {
          app.removeListener('before-quit', captureQuitEvent)
        }
        // Keep IPC pending so a renderer veto can restore the restart action.
        return result.promise
      },
      async exit(code, beforeExit) {
        attempt.abort.signal.throwIfAborted()
        if (attempt.phase !== 'preparing') {
          return
        }
        attempt.phase = 'committing'
        try {
          await launcher.commit()
        } catch (error) {
          cancel(attempt)
          throw error
        }
        try {
          await beforeExit?.()
        } finally {
          app.exit(code)
        }
      }
    }
  } catch (error) {
    cancel(attempt)
    throw error
  }
}

export function isGracefulAppImageRelaunch(): boolean {
  return active?.phase === 'quitting'
}

export async function finishGracefulAppImageRelaunch(): Promise<void> {
  const attempt = active
  if (attempt?.phase !== 'quitting') {
    return
  }
  attempt.phase = 'committing'
  try {
    attempt.beforeCommit?.()
    await attempt.launcher?.commit()
    attempt.quitResult?.resolve()
  } catch (error) {
    attempt.launcher?.cancel()
    console.error('[app] Committed AppImage restart failed. Reopen Orca manually.', error)
    await attempt.launcher?.reportFailure(error)
    attempt.quitResult?.reject(error)
  } finally {
    // Teardown has finished. A second before-quit veto would strand the authorized launcher.
    app.exit(0)
  }
}

export async function relaunchProcessAndExit(
  options: Electron.RelaunchOptions,
  code: number
): Promise<void> {
  const preparation = prepareProcessRelaunch(options)
  if (preparation) {
    await (await preparation).exit(code)
  } else {
    app.relaunch(options)
    app.exit(code)
  }
}
