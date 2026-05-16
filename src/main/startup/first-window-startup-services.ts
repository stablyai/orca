type FirstWindowStartupServices = {
  startDaemonPtyProvider: () => Promise<void>
  startAgentHookServer: () => Promise<void>
  onDaemonError: (error: unknown) => void
  onAgentHookServerError: (error: unknown) => void
}

export const FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS = 12_000

async function startServiceWithTimeout(
  label: string,
  start: () => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const startPromise = start()
    await Promise.race([
      startPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} startup timed out`))
        }, FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
      })
    ])
  } catch (error) {
    onError(error)
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

/**
 * Starts the services that must be ready before restored terminal panes mount.
 */
export async function startFirstWindowStartupServices({
  startDaemonPtyProvider,
  startAgentHookServer,
  onDaemonError,
  onAgentHookServerError
}: FirstWindowStartupServices): Promise<void> {
  // Why: daemon startup and hook-server binding are independent, but both gate
  // restored terminals; run them together so cold-start latency is max(), not sum().
  // They are also fail-open services: a wedged daemon/hook startup must not
  // prevent the first BrowserWindow from existing.
  await Promise.all([
    startServiceWithTimeout('daemon PTY provider', startDaemonPtyProvider, onDaemonError),
    startServiceWithTimeout('agent hook server', startAgentHookServer, onAgentHookServerError)
  ])
}
