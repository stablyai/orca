type ServeSignalSource = {
  on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown
}

export function registerServeSignalHandlers(
  signalSource: ServeSignalSource,
  quitApplication: () => void
): void {
  // Keep every listener installed so duplicate delivery cannot fall through to default termination.
  signalSource.on('SIGINT', quitApplication)
  signalSource.on('SIGTERM', quitApplication)
  signalSource.on('SIGHUP', quitApplication)
}
