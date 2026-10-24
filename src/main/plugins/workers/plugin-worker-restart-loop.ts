import type { PluginRestartDecision } from './plugin-supervisor'

function cancellationError(): Error {
  return new Error('plugin worker activation was cancelled')
}

function waitForBackoff(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    timer.unref?.()
    function onAbort(): void {
      clearTimeout(timer)
      reject(cancellationError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}

export async function runPluginWorkerRestartLoop<T>(options: {
  signal: AbortSignal
  firstRestart?: Extract<PluginRestartDecision, { restart: true }>
  assertActive: () => void
  start: () => Promise<T>
  recordFailure: (error: unknown) => PluginRestartDecision
  erroredError: (error: unknown) => Error
}): Promise<T> {
  let restart = options.firstRestart
  for (;;) {
    if (restart) {
      await waitForBackoff(restart.delayMs, options.signal)
    }
    options.assertActive()
    try {
      return await options.start()
    } catch (error) {
      options.assertActive()
      const decision = options.recordFailure(error)
      if (!decision.restart) {
        throw options.erroredError(error)
      }
      restart = decision
    }
  }
}
