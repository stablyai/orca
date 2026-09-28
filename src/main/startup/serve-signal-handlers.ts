import { registerServeSupervisorControl } from '../../shared/serve-supervisor-control'

type ServeSignalSource = {
  on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  send?: (message: string, callback: (error: Error | null) => void) => boolean
}

export function registerServeSignalHandlers(
  signalSource: ServeSignalSource,
  quitApplication: () => void
): void {
  // Keep every listener installed so duplicate delivery cannot fall through to default termination.
  signalSource.on('SIGINT', quitApplication)
  signalSource.on('SIGTERM', quitApplication)
  signalSource.on('SIGHUP', quitApplication)
  registerServeSupervisorControl(signalSource, quitApplication)
}
