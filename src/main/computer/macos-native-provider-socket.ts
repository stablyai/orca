import net from 'net'
import { RuntimeClientError } from './runtime-client-error'

export async function connectMacOSProviderSocket(
  socketPath: string,
  timeoutMs: number
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | null = null
  while (Date.now() < deadline) {
    try {
      return await connectSocket(socketPath)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new RuntimeClientError(
    'action_timeout',
    `native macOS helper app did not open its socket: ${lastError?.message ?? 'timed out'}`
  )
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const onError = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolve(socket)
    })
  })
}
