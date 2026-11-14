/** Ctrl-C everywhere; Ctrl-Break on Windows; a closed terminal or `kill` on POSIX. */
function stopSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
}

type SignalTarget = {
  platform: NodeJS.Platform
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

export function onPluginDevWatchInterrupt(
  listener: () => void,
  target: SignalTarget = process
): () => void {
  const signals = stopSignals(target.platform)
  for (const signal of signals) {
    target.on(signal, listener)
  }
  return () => {
    for (const signal of signals) {
      target.off(signal, listener)
    }
  }
}

export function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
