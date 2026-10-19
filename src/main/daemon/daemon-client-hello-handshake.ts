import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'
import { BINARY_STREAM_FRAMING, type DaemonStreamFraming } from './daemon-stream-binary-framing'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION, DaemonProtocolError } from './types'
import type { DaemonEndpointIdentity, HelloMessage, HelloResponse } from './types'
import { addNodePtyRecoveryHint } from './node-pty-error-hints'

export type DaemonHelloRequest = {
  socket: Socket
  token: string
  role: 'control' | 'stream'
  timeoutMs: number
  protocolVersion: number
  clientId: string
  /** Ask a stream socket for binary PTY frames; the daemon's reply decides. */
  requestBinaryStream?: boolean
}

// Kill switch: ORCA_DAEMON_BINARY_STREAM=0 keeps every stream socket on NDJSON.
const REQUEST_BINARY_STREAM_BY_DEFAULT = process.env.ORCA_DAEMON_BINARY_STREAM !== '0'

export type DaemonHelloOutcome = {
  identity: DaemonEndpointIdentity | null
  streamFraming: DaemonStreamFraming
  /** Bytes after the hello line in the same read; the socket's next reader must start with them. */
  remainder: Buffer
}

export function sendDaemonHello(request: DaemonHelloRequest): Promise<DaemonHelloOutcome> {
  const { socket, token, role, timeoutMs, protocolVersion, clientId } = request
  const requestBinaryStream =
    role === 'stream' && (request.requestBinaryStream ?? REQUEST_BINARY_STREAM_BY_DEFAULT)
  return new Promise((resolve, reject) => {
    const hello: HelloMessage = {
      type: 'hello',
      version: protocolVersion,
      token,
      clientId,
      role,
      ...(requestBinaryStream ? { streamFraming: BINARY_STREAM_FRAMING } : {})
    }

    const chunks: Buffer[] = []
    let bufferedBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const finish = (error?: Error, outcome?: DaemonHelloOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error || !outcome) {
        reject(error ?? new DaemonProtocolError('Invalid hello response'))
        return
      }
      resolve(outcome)
    }
    // Binary frame prefixes following hello must remain exact bytes.
    const onData = (chunk: Buffer): void => {
      const newlineIdx = chunk.indexOf(0x0a)
      const lineBytes = bufferedBytes + (newlineIdx === -1 ? chunk.length : newlineIdx)
      if (lineBytes > NDJSON_MAX_LINE_BYTES) {
        finish(new DaemonProtocolError('Hello response exceeds maximum line size'))
        socket.destroy()
        return
      }
      if (newlineIdx === -1) {
        chunks.push(chunk)
        bufferedBytes = lineBytes
        return
      }

      // Flowing sockets otherwise drain buffered chunks before the awaiting reader can attach.
      socket.pause()
      chunks.push(chunk.subarray(0, newlineIdx))
      const line = Buffer.concat(chunks, lineBytes).toString('utf8')
      const remainder = chunk.subarray(newlineIdx + 1)
      try {
        const response = JSON.parse(line) as HelloResponse
        if (response.ok) {
          const identity = parseDaemonEndpointIdentity(response.daemonIdentity)
          if (
            (protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION && identity === null) ||
            (response.daemonIdentity !== undefined && identity === null)
          ) {
            finish(new DaemonProtocolError('Invalid daemon identity'))
            return
          }
          const streamFraming =
            requestBinaryStream && response.streamFraming === BINARY_STREAM_FRAMING
              ? BINARY_STREAM_FRAMING
              : 'ndjson'
          finish(undefined, { identity, streamFraming, remainder })
        } else {
          finish(
            new DaemonProtocolError(addNodePtyRecoveryHint(response.error ?? 'Hello rejected'))
          )
        }
      } catch {
        finish(new DaemonProtocolError('Invalid hello response'))
      }
    }
    const onError = (error: Error): void => finish(error)
    const onClose = (): void =>
      finish(new DaemonProtocolError('Connection closed before hello response'))

    timer = setTimeout(() => {
      // Why: a stale daemon can accept the socket but never answer hello;
      // without a handshake timeout, startup waits forever on ensureConnected().
      finish(new DaemonProtocolError('Hello response timed out'))
      socket.destroy()
    }, timeoutMs)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.write(encodeNdjson(hello))
  })
}

function parseDaemonEndpointIdentity(value: unknown): DaemonEndpointIdentity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const identity = value as {
    pid?: unknown
    startedAtMs?: unknown
    launchNonce?: unknown
    entryPath?: unknown
    appVersion?: unknown
    spawnerExecPath?: unknown
  }
  if (
    !Number.isSafeInteger(identity.pid) ||
    (identity.pid as number) <= 0 ||
    typeof identity.startedAtMs !== 'number' ||
    !Number.isFinite(identity.startedAtMs) ||
    identity.startedAtMs <= 0 ||
    typeof identity.launchNonce !== 'string' ||
    identity.launchNonce.length === 0
  ) {
    return null
  }
  return {
    pid: identity.pid as number,
    startedAtMs: identity.startedAtMs,
    launchNonce: identity.launchNonce,
    ...(typeof identity.entryPath === 'string' && identity.entryPath.length > 0
      ? { entryPath: identity.entryPath }
      : {}),
    ...(typeof identity.appVersion === 'string' && identity.appVersion.length > 0
      ? { appVersion: identity.appVersion }
      : {}),
    ...(typeof identity.spawnerExecPath === 'string' && identity.spawnerExecPath.length > 0
      ? { spawnerExecPath: identity.spawnerExecPath }
      : {})
  }
}

export function sameDaemonIdentity(
  left: DaemonEndpointIdentity | null,
  right: DaemonEndpointIdentity | null
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.pid === right.pid &&
      left.startedAtMs === right.startedAtMs &&
      left.launchNonce === right.launchNonce)
  )
}
