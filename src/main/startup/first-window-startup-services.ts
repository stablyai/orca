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
// #5232: wait for slow daemon startup to avoid local PTYs lost on quit; this cap only breaks deadlocks.
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

/** Gate restored terminals on daemon/hook readiness. */
export function startFirstWindowStartupServices({
  startDaemonPtyProvider,
  startAgentHookServer,
  onDaemonError,
  onAgentHookServerError
}: FirstWindowStartupServices): FirstWindowStartupServicesResult {
  // Start independent services concurrently. Reveal the window sooner, but hold PTYs until settlement or hard-cap abort so late daemon swaps cannot strand fallback PTYs.
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
  // Terminal destruction needs only daemon authority; optional hooks must not delay close.
  const localPtyProviderReady = Promise.race([daemon.ready, failOpenReady])

  return { firstWindowReady, localPtyReady, localPtyProviderReady }
}
