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
  localPtyProviderReady: Promise<void>
}

export const FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS = 12_000
// Bound the startup gate without discarding a daemon that becomes ready later.
export const LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS = 60_000

function startService(
  label: string,
  start: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
  abortOnTimeout = true
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
      if (abortOnTimeout) {
        abortController.abort()
      }
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
  // Independent services start together; a timeout opens the UI but leaves daemon recovery running.
  const daemon = startService('daemon PTY provider', startDaemonPtyProvider, onDaemonError, false)
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
  const failOpenReady = new Promise<void>((resolve) => {
    failOpenTimeout = setTimeout(() => {
      daemon.reportTimeout()
      hooks.reportTimeout()
      resolve()
    }, LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
  })
  const firstWindowReady = Promise.race([
    servicesSettled,
    new Promise<void>((resolve) => {
      windowTimeout = setTimeout(resolve, FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
    })
  ])
  const localPtyReady = Promise.race([servicesSettled, failOpenReady])
  // Why: destructive routing only needs daemon authority. A stalled optional
  // hook server must not hold terminal close for the full fail-open window.
  const localPtyProviderReady = Promise.race([daemon.ready, failOpenReady])

  return { firstWindowReady, localPtyReady, localPtyProviderReady }
}
