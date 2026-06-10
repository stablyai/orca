type FirstWindowStartupServices = {
  startDaemonPtyProvider: (signal: AbortSignal) => Promise<void>
  startAgentHookServer: (signal: AbortSignal) => Promise<void>
  onDaemonError: (error: unknown) => void
  onAgentHookServerError: (error: unknown) => void
}

type StartupService = {
  ready: Promise<void>
  reportTimeout: () => void
}

type FirstWindowStartupServicesResult = {
  firstWindowReady: Promise<void>
  localPtyReady: Promise<void>
}

export const FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS = 12_000

function startService(
  label: string,
  start: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void
): StartupService {
  const abortController = new AbortController()
  let settled = false
  let reportedTimeout = false
  const ready = Promise.resolve()
    .then(() => start(abortController.signal))
    .catch((error) => {
      if (!reportedTimeout) {
        onError(error)
      }
    })
    .finally(() => {
      settled = true
    })

  return {
    ready,
    reportTimeout: () => {
      if (settled) {
        return
      }
      reportedTimeout = true
      abortController.abort()
      onError(new Error(`${label} startup timed out`))
    }
  }
}

/**
 * Starts the services that must be ready before restored terminal panes mount.
 */
export function startFirstWindowStartupServices({
  startDaemonPtyProvider,
  startAgentHookServer,
  onDaemonError,
  onAgentHookServerError
}: FirstWindowStartupServices): FirstWindowStartupServicesResult {
  // Why: daemon startup and hook-server binding are independent, but both gate
  // restored terminals; run them together so cold-start latency is max(), not sum().
  // The first window and local PTY startup both fail open after the timeout.
  // The timeout also aborts slow services so late daemon swaps cannot strand
  // any fallback LocalPtyProvider PTYs that spawn after the barrier opens.
  const daemon = startService('daemon PTY provider', startDaemonPtyProvider, onDaemonError)
  const hooks = startService('agent hook server', startAgentHookServer, onAgentHookServerError)
  const allServicesReady = Promise.all([daemon.ready, hooks.ready]).then(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | null = null
  let resolveTimedOut!: () => void
  const timedOut = new Promise<void>((resolve) => {
    resolveTimedOut = resolve
  })
  const firstWindowReady = Promise.race([
    allServicesReady.finally(() => {
      if (timeout) {
        clearTimeout(timeout)
      }
    }),
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        daemon.reportTimeout()
        hooks.reportTimeout()
        resolveTimedOut()
        resolve()
      }, FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
    })
  ])
  const localPtyReady = Promise.race([allServicesReady, timedOut])

  return { firstWindowReady, localPtyReady }
}
