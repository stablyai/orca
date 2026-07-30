import type net from 'node:net'
import { release } from 'node:os'
import {
  claimSupervisedMacOSProvider,
  releaseSupervisedMacOSProvider,
  startSupervisedMacOSProvider
} from './computer-provider-supervisor-client'
import { connectMacOSProviderSocket } from './macos-native-provider-socket'
import { RuntimeClientError } from './runtime-client-error'

const HELPER_CONNECT_TIMEOUT_MS = 10_000

export type StartedMacOSProviderSocket = {
  socket: net.Socket
  sessionId: string
  socketPath: string
  socketToken: string
}

export function isMacOS14OrNewer(): boolean {
  const darwinMajor = Number.parseInt(release().split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) && darwinMajor >= 23
}

// Why: Node treats unhandled socket 'error' events as process exceptions, so
// stale helper sockets keep a no-op listener that does not retain the client.
export function ignoreStaleSocketError(): void {}

export function attachMacOSNativeProviderSocketListeners(
  socket: net.Socket,
  listeners: {
    data: (chunk: string) => void
    close: () => void
    error: (error: Error) => void
  }
): () => void {
  socket.on('data', listeners.data)
  socket.on('close', listeners.close)
  socket.on('error', listeners.error)
  return () => {
    socket.off('data', listeners.data)
    socket.off('close', listeners.close)
    socket.off('error', listeners.error)
    socket.off('error', ignoreStaleSocketError)
    socket.on('error', ignoreStaleSocketError)
  }
}

export function consumeNativeProviderLines(
  buffer: string,
  handleLine: (line: string) => void
): string {
  let remaining = buffer
  while (true) {
    const newline = remaining.indexOf('\n')
    if (newline < 0) {
      return remaining
    }
    const line = remaining.slice(0, newline)
    remaining = remaining.slice(newline + 1)
    if (line.trim()) {
      handleLine(line)
    }
  }
}

export async function startMacOSNativeProviderSocket({
  isCurrent
}: {
  isCurrent: (socketPath: string) => boolean
}): Promise<StartedMacOSProviderSocket> {
  const started = await startSupervisedMacOSProvider()
  const connectAbort = new AbortController()
  let socket: net.Socket | null = null
  try {
    socket = await Promise.race([
      connectMacOSProviderSocket(
        started.socketPath,
        HELPER_CONNECT_TIMEOUT_MS,
        connectAbort.signal
      ),
      started.termination
    ])
    if (!isCurrent(started.socketPath)) {
      socket.destroy()
      throw new RuntimeClientError(
        'accessibility_error',
        'native macOS provider startup was superseded'
      )
    }
    await claimSupervisedMacOSProvider(started.sessionId)
    if (!isCurrent(started.socketPath)) {
      socket.destroy()
      throw new RuntimeClientError(
        'accessibility_error',
        'native macOS provider startup was superseded'
      )
    }
    return {
      socket,
      sessionId: started.sessionId,
      socketPath: started.socketPath,
      socketToken: started.socketToken
    }
  } catch (error) {
    connectAbort.abort()
    socket?.destroy()
    await releaseSupervisedMacOSProvider(started.sessionId).catch(() => undefined)
    throw error
  }
}

export function releaseMacOSNativeProviderSocketSession(sessionId: string): Promise<void> {
  return releaseSupervisedMacOSProvider(sessionId)
}
