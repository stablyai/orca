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
// Why: a slow (but succeeding) daemon start must not flip terminals to the
// LocalPtyProvider fallback — local PTYs are killed on quit, so panes bound to
// them lose their daemon sessions permanently (#5232). The PTY gate therefore
// waits for the daemon attempt itself and only fail-opens at a hard cap that
// exists solely as a deadlock backstop.
export const LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS = 60_000

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
  // The first window fails open quickly so the user sees the app; the local PTY
  // gate waits for the services themselves (a slow daemon must not flip spawns
  // to the non-restorable LocalPtyProvider fallback) and only fails open at the
  // hard cap, which also aborts the services so a late daemon swap cannot
  // strand any fallback PTYs that spawn after the gate opens.
  const daemon = startService('daemon PTY provider', startDaemonPtyProvider, onDaemonError)
  const hooks = startService('agent hook server', startAgentHookServer, onAgentHookServerError)
  const allServicesReady = Promise.all([daemon.ready, hooks.ready]).then(() => undefined)
  let windowTimeout: ReturnType<typeof setTimeout> | null = null
  let failOpenTimeout: ReturnType<typeof setTimeout> | null = null
  const servicesSettled = allServicesReady.finally(() => {
    if (windowTimeout) {
      clearTimeout(windowTimeout)
    }
    if (failOpenTimeout) {
      clearTimeout(failOpenTimeout)
    }
  })
  const firstWindowReady = Promise.race([
    servicesSettled,
    new Promise<void>((resolve) => {
      windowTimeout = setTimeout(resolve, FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
    })
  ])
  const localPtyReady = Promise.race([
    servicesSettled,
    new Promise<void>((resolve) => {
      failOpenTimeout = setTimeout(() => {
        daemon.reportTimeout()
        hooks.reportTimeout()
        resolve()
      }, LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
    })
  ])

  return { firstWindowReady, localPtyReady }
}
