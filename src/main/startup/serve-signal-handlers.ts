type ServeSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'
type SignalListener = (signal: NodeJS.Signals) => void

export type ServeSignalSource = {
  on(event: ServeSignal, listener: SignalListener): unknown
  removeListener(event: ServeSignal, listener: SignalListener): unknown
  listeners(event: ServeSignal): SignalListener[]
}

export function registerServeSignalHandlers(
  signalSource: ServeSignalSource,
  quitApplication: () => void
): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    // After ready, remove every listener to release Node's handle, then re-add so Node reclaims signals Electron replaced.
    const existing = signalSource.listeners(signal)
    for (const listener of existing) {
      signalSource.removeListener(signal, listener)
    }
    for (const listener of existing) {
      signalSource.on(signal, listener)
    }
    // Keep handlers installed across duplicate signals so default termination cannot bypass cleanup.
    signalSource.on(signal, quitApplication)
  }
}
