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
    // Why reclaim: Electron's native handler replaces Node's for any signal that already had a
    // listener before app ready, so these never ran and a SIGTERM arrived as a native quit.
    // Dropping the last listener releases Node's handler; re-adding installs it over Electron's.
    const existing = signalSource.listeners(signal)
    for (const listener of existing) {
      signalSource.removeListener(signal, listener)
    }
    for (const listener of existing) {
      signalSource.on(signal, listener)
    }
    // Keep every listener installed so duplicate delivery cannot fall through to default termination.
    signalSource.on(signal, quitApplication)
  }
}
