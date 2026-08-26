type ServeSignalSource = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export function registerServeSignalHandlers(
  signalSource: ServeSignalSource,
  quitApplication: () => void
): void {
  // Keep both listeners installed so duplicate delivery cannot fall through to default termination.
  signalSource.on('SIGINT', quitApplication)
  signalSource.on('SIGTERM', quitApplication)
}
