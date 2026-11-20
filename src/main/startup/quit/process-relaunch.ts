import { app, type Event } from 'electron'
import { isEphemeralAppImageRuntime } from '../../updater/linux-package/appimage-runtime-identity'
import { mainProcessState } from '../main-process-state'
import { runWithLaunchPath } from '../shell-environment/hydrate-shell-path'
import { prepareAppImageRelaunch, type PreparedAppRelaunch } from './appimage-relaunch'
import { isHostShuttingDown } from './host-shutdown-state'
import { quitProcess } from './process-quit-request'

type RelaunchAttempt = {
  abort: AbortController
  phase: 'preparing' | 'quitting' | 'committing'
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
  if (active && active.phase !== 'committing' && !isHostShuttingDown()) {
    cancel(active)
  }
}

export function cancelProcessRelaunchPreparation(): void {
  if (active?.phase === 'preparing') {
    cancelProcessRelaunch()
  }
}

export type ProcessRelaunch = {
  quit(): Promise<void>
  exit(code: number, beforeExit?: () => void): Promise<void>
  cancel(): void
}

export async function prepareProcessRelaunch(
  options?: Electron.RelaunchOptions
): Promise<ProcessRelaunch> {
  if (active || mainProcessState.isQuitting || isHostShuttingDown()) {
    throw new Error('Orca is already restarting or quitting.')
  }
  const attempt: RelaunchAttempt = { abort: new AbortController(), phase: 'preparing' }
  active = attempt
  try {
    const launcher =
      app.isPackaged && options?.execPath === undefined && isEphemeralAppImageRuntime()
        ? await prepareAppImageRelaunch(
            options?.args ?? process.argv.slice(1),
            attempt.abort.signal
          )
        : {
            commit: async () => runWithLaunchPath(() => app.relaunch(options)),
            cancel: () => {}
          }
    attempt.launcher = launcher
    attempt.abort.signal.throwIfAborted()
    return {
      cancel() {
        if (attempt.phase === 'preparing') {
          cancel(attempt)
        }
      },
      async quit() {
        attempt.abort.signal.throwIfAborted()
        if (attempt.phase !== 'preparing') {
          return attempt.quitResult?.promise
        }
        attempt.phase = 'quitting'
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
          if (quitEvent?.defaultPrevented) {
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
          beforeExit?.()
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

/** Called after will-quit has passed the renderer vetoes and completed teardown. */
export async function commitGracefulProcessRelaunch(): Promise<void> {
  const attempt = active
  if (attempt?.phase === 'quitting') {
    attempt.phase = 'committing'
    try {
      await attempt.launcher?.commit()
      attempt.quitResult?.resolve()
    } catch (error) {
      attempt.quitResult?.reject(error)
      throw error
    }
  }
}
