import { connect, type Socket } from 'node:net'
import { DaemonProtocolError } from './types'
import { ensureDaemonSocketDir } from './daemon-socket-endpoint-path'

export function connectDaemonSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // Reject untrusted socket directories before sending the hello token.
    ensureDaemonSocketDir(socketPath)
    const socket = connect(socketPath)
    const cleanup = (): void => {
      clearTimeout(timer)
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
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new DaemonProtocolError('Connection timed out'))
    }, timeoutMs)

    socket.on('connect', onConnect)
    socket.on('error', onError)
  })
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
    const timer = setTimeout(() => {
      reject(new DaemonProtocolError('Connection attempt wait timed out'))
    }, timeoutMs)
    attempt.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
