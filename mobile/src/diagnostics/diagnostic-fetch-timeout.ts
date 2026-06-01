export type DiagnosticFetchTimeout = {
  readonly signal: AbortSignal
  readonly timedOut: boolean
  dispose: () => void
}

export function startDiagnosticFetchTimeout(timeoutMs: number): DiagnosticFetchTimeout {
  const controller = new AbortController()
  let disposed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    timedOut = true
    controller.abort()
  }, timeoutMs)

  function dispose() {
    if (disposed) {
      return
    }
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    dispose
  }
}
