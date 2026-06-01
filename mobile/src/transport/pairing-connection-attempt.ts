export type PairingConnectionAttempt = {
  readonly timedOut: boolean
  dispose: () => void
}

export function startPairingConnectionAttempt({
  timeoutMs,
  closeClient
}: {
  timeoutMs: number
  closeClient: () => void
}): PairingConnectionAttempt {
  let disposed = false
  let clientClosed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function closeClientOnce() {
    if (clientClosed) {
      return
    }
    clientClosed = true
    closeClient()
  }

  function dispose() {
    if (disposed) {
      return
    }
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    closeClientOnce()
  }

  timer = setTimeout(() => {
    timer = null
    timedOut = true
    dispose()
  }, timeoutMs)

  return {
    get timedOut() {
      return timedOut
    },
    dispose
  }
}
