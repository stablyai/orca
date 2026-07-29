import net from 'node:net'
import { RuntimeClientError } from './runtime-client-error'

export async function connectMacOSProviderSocket(
  socketPath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | null = null
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      return await connectSocket(socketPath, signal)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (signal?.aborted) {
        break
      }
      await sleep(100, signal)
    }
  }
  if (signal?.aborted) {
    throw new RuntimeClientError(
      'accessibility_error',
      'native macOS helper app startup was cancelled'
    )
  }
  throw new RuntimeClientError(
    'action_timeout',
    `native macOS helper app did not open its socket: ${lastError?.message ?? 'timed out'}`
  )
}

function connectSocket(socketPath: string, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new RuntimeClientError(
          'accessibility_error',
          'native macOS helper app startup was cancelled'
        )
      )
      return
    }
    const socket = net.createConnection(socketPath)
    const cleanup = (): void => {
      socket.off('error', onError)
      socket.off('connect', onConnect)
      signal?.removeEventListener('abort', onAbort)
    }
    const onError = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onConnect = (): void => {
      cleanup()
      resolve(socket)
    }
    const onAbort = (): void => {
      cleanup()
      socket.destroy()
      reject(
        new RuntimeClientError(
          'accessibility_error',
          'native macOS helper app startup was cancelled'
        )
      )
    }
    socket.once('error', onError)
    socket.once('connect', onConnect)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
