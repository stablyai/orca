import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/app-lifecycle/shutdown/quit-teardown-deadline'

// A Windows update exit must finish inside WINDOWS_UPDATE_INSTALL_EXIT_TIMEOUT_MS (8 s), whose
// watchdog starts slightly before quit does: teardown plus the worker-store save stay 2 s under it.
export const WINDOWS_UPDATE_QUIT_TEARDOWN_DEADLINE_MS = 4_000
export const WINDOWS_UPDATE_WORKER_STORE_DEADLINE_MS = 2_000

function isWindowsUpdateQuit(updateQuit: boolean, platform: NodeJS.Platform): boolean {
  return updateQuit && platform === 'win32'
}

export function quitTeardownDeadlineMs(
  updateQuit: boolean,
  platform: NodeJS.Platform = process.platform
): number {
  return isWindowsUpdateQuit(updateQuit, platform)
    ? WINDOWS_UPDATE_QUIT_TEARDOWN_DEADLINE_MS
    : WILL_QUIT_TEARDOWN_DEADLINE_MS
}

export function quitWorkerStoreDeadlineMs(
  updateQuit: boolean,
  platform: NodeJS.Platform = process.platform
): number {
  return isWindowsUpdateQuit(updateQuit, platform)
    ? WINDOWS_UPDATE_WORKER_STORE_DEADLINE_MS
    : WILL_QUIT_TEARDOWN_DEADLINE_MS
}

export type NamedQuitTeardown = {
  name: string
  promise: Promise<unknown>
}

export async function settleTeardownWithinDeadline(
  teardowns: readonly NamedQuitTeardown[],
  deadlineMs: number = WILL_QUIT_TEARDOWN_DEADLINE_MS
): Promise<string[]> {
  const pendingNames = new Set(teardowns.map(({ name }) => name))
  const settled = Promise.allSettled(
    teardowns.map(({ name, promise }) =>
      promise.finally(() => {
        pendingNames.delete(name)
      })
    )
  ).then(() => 'settled' as const)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs)
    timer.unref?.()
  })
  const outcome = await Promise.race([settled, deadline])
  clearTimeout(timer)
  return outcome === 'deadline' ? [...pendingNames] : []
}

/**
 * Bounded teardown, then the final saves, then diagnostics. Saves run before diagnostics so an exit
 * deadline cuts telemetry, not data.
 */
export async function finishQuitTeardown(input: {
  teardowns: readonly NamedQuitTeardown[]
  deadlineMs: number
  /** Unbounded, as their old synchronous will-quit saves were. */
  closeDataStores: () => Promise<unknown>
  /** A worker that a stalled disk can wedge; bounded so quit cannot hang (#9447). */
  closeWorkerStores: () => Promise<unknown>
  workerStoreDeadlineMs: number
  shutdownDiagnostics: () => Promise<unknown>
}): Promise<{ teardownsFulfilled: boolean }> {
  const rejected = new Set<string>()
  const pendingTeardowns = await settleTeardownWithinDeadline(
    input.teardowns.map(({ name, promise }) => ({
      name,
      promise: promise.catch((error: unknown) => {
        rejected.add(name)
        throw error
      })
    })),
    input.deadlineMs
  )
  if (pendingTeardowns.length > 0) {
    console.warn('[shutdown] Quit teardown deadline reached', { pendingTeardowns })
  }
  await Promise.all([
    settleWithinMs(input.closeWorkerStores(), input.workerStoreDeadlineMs).then((result) => {
      if (result.outcome === 'timed-out') {
        console.warn('[shutdown] Worker store close deadline reached')
      }
    }),
    input.closeDataStores().catch(() => {})
  ])
  // Telemetry must never prevent app.quit().
  await input.shutdownDiagnostics().catch(() => {})
  // A rejected or unsettled teardown may have left a writer behind.
  return { teardownsFulfilled: pendingTeardowns.length === 0 && rejected.size === 0 }
}

export type SettledWithinMs<T> =
  | { outcome: 'settled'; value: T }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'timed-out' }

// Keep failures distinct from timeouts so quit diagnostics remain accurate.
export async function settleWithinMs<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<SettledWithinMs<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        (value): SettledWithinMs<T> => ({ outcome: 'settled', value }),
        (error): SettledWithinMs<T> => ({ outcome: 'failed', error })
      ),
      new Promise<SettledWithinMs<T>>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: 'timed-out' }), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
