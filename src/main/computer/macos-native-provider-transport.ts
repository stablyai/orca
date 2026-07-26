import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type net from 'node:net'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectMacOSProviderSocket } from './macos-native-provider-socket'
import { RuntimeClientError } from './runtime-client-error'
import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'

const HELPER_CONNECT_TIMEOUT_MS = 10_000
export const MACOS_NATIVE_PROVIDER_MAX_RESPONSE_LINE_BYTES = 64 * 1024 * 1024

export class MacOSNativeProviderResponseTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`native macOS provider response exceeded ${maxBytes} byte line limit`)
    this.name = 'MacOSNativeProviderResponseTooLargeError'
  }
}

export type StartedMacOSProviderSocket = {
  socket: net.Socket
  socketDirectory: string
  socketPath: string
  socketToken: string
}

export class MacOSNativeProviderLineBuffer {
  private readonly pending = new GrowingByteBuffer()

  constructor(private readonly maxLineBytes = MACOS_NATIVE_PROVIDER_MAX_RESPONSE_LINE_BYTES) {}

  feed(chunk: string, handleLine: (line: string) => void): void {
    let remaining = chunk
    while (remaining.length > 0) {
      const newline = remaining.indexOf('\n')
      const hasNewline = newline >= 0
      const segment = hasNewline ? remaining.slice(0, newline) : remaining
      remaining = hasNewline ? remaining.slice(newline + 1) : ''
      const segmentBytes = Buffer.byteLength(segment)
      const observedBytes = this.pending.byteLength + segmentBytes
      if (observedBytes > this.maxLineBytes) {
        this.pending.clear()
        throw new MacOSNativeProviderResponseTooLargeError(observedBytes, this.maxLineBytes)
      }
      this.pending.append(Buffer.from(segment))
      if (!hasNewline) {
        return
      }
      const line = this.pending.takeString('utf8')
      if (line.trim()) {
        handleLine(line)
      }
    }
  }

  clear(): void {
    this.pending.clear()
  }
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
  handleLine: (line: string) => void,
  maxLineBytes = MACOS_NATIVE_PROVIDER_MAX_RESPONSE_LINE_BYTES
): string {
  let remaining = buffer
  while (true) {
    const newline = remaining.indexOf('\n')
    if (newline < 0) {
      const remainingBytes = Buffer.byteLength(remaining)
      if (remainingBytes > maxLineBytes) {
        throw new MacOSNativeProviderResponseTooLargeError(remainingBytes, maxLineBytes)
      }
      return remaining
    }
    const line = remaining.slice(0, newline)
    remaining = remaining.slice(newline + 1)
    const lineBytes = Buffer.byteLength(line)
    if (lineBytes > maxLineBytes) {
      throw new MacOSNativeProviderResponseTooLargeError(lineBytes, maxLineBytes)
    }
    if (line.trim()) {
      handleLine(line)
    }
  }
}

export async function startMacOSNativeProviderSocket({
  helperExecutablePath,
  isCurrent
}: {
  helperExecutablePath: string
  isCurrent: (socketPath: string) => boolean
}): Promise<StartedMacOSProviderSocket> {
  const socketDirectory = mkdtempSync(join(tmpdir(), 'orca-computer-use-'))
  chmodSync(socketDirectory, 0o700)
  const socketPath = join(socketDirectory, 'provider.sock')
  const socketToken = randomUUID()
  const socketTokenPath = join(socketDirectory, 'provider.token')
  writeFileSync(socketTokenPath, socketToken, { encoding: 'utf8', mode: 0o600 })
  // Why: launching the nested helper via LaunchServices can make TCC evaluate
  // Orca.app as responsible; the signed helper executable owns this grant.
  const provider = spawnProvider(helperExecutablePath, socketPath, socketTokenPath)
  const providerFailure = waitForProviderLaunchFailure(provider)
  const connectAbort = new AbortController()
  try {
    const socket = await Promise.race([
      connectMacOSProviderSocket(socketPath, HELPER_CONNECT_TIMEOUT_MS, connectAbort.signal),
      providerFailure.promise
    ])
    providerFailure.cleanup()
    rmSync(socketTokenPath, { force: true })
    if (!isCurrent(socketPath)) {
      socket.destroy()
      cleanupSocketDirectory(socketDirectory)
      throw new RuntimeClientError(
        'accessibility_error',
        'native macOS provider startup was superseded'
      )
    }
    return { socket, socketDirectory, socketPath, socketToken }
  } catch (error) {
    connectAbort.abort()
    providerFailure.cleanup()
    // Why: connect failures happen after spawn; terminate the detached helper
    // so repeated startup attempts do not leave orphan providers.
    provider.kill('SIGTERM')
    if (isCurrent(socketPath)) {
      cleanupSocketDirectory(socketDirectory)
    }
    throw error
  }
}

function cleanupSocketDirectory(socketDirectory: string): void {
  rmSync(socketDirectory, { recursive: true, force: true })
}

function spawnProvider(
  helperExecutablePath: string,
  socketPath: string,
  socketTokenPath: string
): ChildProcess {
  const provider = spawn(
    helperExecutablePath,
    ['--agent', socketPath, '--token-file', socketTokenPath],
    { detached: true, stdio: 'ignore' }
  )
  provider.unref()
  return provider
}

function waitForProviderLaunchFailure(provider: ChildProcess): {
  promise: Promise<never>
  cleanup: () => void
} {
  let cleanup = (): void => {}
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (error: Error) => {
      reject(
        new RuntimeClientError(
          'accessibility_error',
          `native macOS helper app failed to start: ${error.message}`
        )
      )
    }
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new RuntimeClientError(
          'accessibility_error',
          `native macOS helper app exited before connecting: ${
            typeof code === 'number' ? `code ${code}` : `signal ${signal ?? 'unknown'}`
          }`
        )
      )
    }
    provider.once('error', fail)
    provider.once('exit', exit)
    cleanup = () => {
      provider.off('error', fail)
      provider.off('exit', exit)
    }
  })
  return { promise, cleanup }
}
