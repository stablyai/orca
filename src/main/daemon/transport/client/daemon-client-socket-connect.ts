import { connect, type Socket } from 'node:net'
import { DaemonProtocolError } from '../../protocol/daemon-errors'
import { ensureDaemonSocketDir } from '../../endpoint/publication/daemon-socket-endpoint-path'
import { startResponsiveDeadline } from './daemon-responsive-deadline'

export function connectDaemonSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // Reject untrusted socket directories before sending the hello token.
    ensureDaemonSocketDir(socketPath)
    const socket = connect(socketPath)
    const cleanup = (): void => {
      cancelDeadline()
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
    }
    const onConnect = (): void => {
      cleanup()
      resolve(socket)
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    // A connect that completed while this process was frozen must not be timed out ahead of its event.
    const cancelDeadline = startResponsiveDeadline(timeoutMs, () => {
      cleanup()
      socket.destroy()
      reject(new DaemonProtocolError('Connection timed out'))
    })

    socket.on('connect', onConnect)
    socket.on('error', onError)
  })
}

// Watch the authenticated control socket for failure until its permanent close handlers are armed.
export function watchControlSocketBootstrap(socket: Socket): {
  race: <T>(step: Promise<T>) => Promise<T>
  connect: (socketPath: string, timeoutMs: number) => Promise<Socket>
  stop: () => void
} {
  const failure = Promise.withResolvers<never>()
  const onClose = (): void =>
    failure.reject(new DaemonProtocolError('Control socket closed during connection'))
  socket.on('error', failure.reject)
  socket.on('close', onClose)
  const race = <T>(step: Promise<T>): Promise<T> => Promise.race([step, failure.promise])
  return {
    race,
    connect: (socketPath, timeoutMs) => {
      const connecting = connectDaemonSocket(socketPath, timeoutMs)
      return race(connecting).catch((error: unknown) => {
        // A socket that connects after the attempt failed has no owner left to close it.
        void connecting.then(
          (late) => late.destroy(),
          () => {}
        )
        throw error
      })
    },
    stop: () => {
      socket.off('error', failure.reject)
      socket.off('close', onClose)
    }
  }
}

// Capture socket values because teardown nulls the client fields before cleanup.
export function armDaemonSocketCloseHandlers(
  controlSocket: Socket,
  streamSocket: Socket,
  handleClose: () => void,
  drainStream: (done: () => void) => void
): () => void {
  // Drain buffered output before control close destroys the stream socket.
  const handleControlClose = (): void => drainStream(handleClose)
  controlSocket.on('close', handleControlClose)
  controlSocket.on('error', handleControlClose)
  streamSocket.on('close', handleClose)
  streamSocket.on('error', handleClose)
  return () => {
    controlSocket.off('close', handleControlClose)
    controlSocket.off('error', handleControlClose)
    streamSocket.off('close', handleClose)
    streamSocket.off('error', handleClose)
  }
}

export function waitForDaemonConnectionAttempt(
  attempt: Promise<void>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelDeadline = startResponsiveDeadline(timeoutMs, () => {
      reject(new DaemonProtocolError('Connection attempt wait timed out'))
    })
    attempt.then(
      () => {
        cancelDeadline()
        resolve()
      },
      (error) => {
        cancelDeadline()
        reject(error)
      }
    )
  })
}
