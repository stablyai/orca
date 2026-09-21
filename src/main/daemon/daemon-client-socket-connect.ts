import { connect, type Socket } from 'node:net'
import { DaemonProtocolError } from './types'

export function connectDaemonSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
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

// Why: capture both sockets by value — the fields they came from are nulled on teardown,
// so a cleanup reading them back would unhook nothing.
export function armDaemonSocketCloseHandlers(
  controlSocket: Socket,
  streamSocket: Socket,
  handleClose: () => void
): () => void {
  controlSocket.on('close', handleClose)
  controlSocket.on('error', handleClose)
  streamSocket.on('close', handleClose)
  streamSocket.on('error', handleClose)
  return () => {
    controlSocket.off('close', handleClose)
    controlSocket.off('error', handleClose)
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
