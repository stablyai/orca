import type { Duplex } from 'node:stream'
import { encodeNdjson } from './ndjson'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION, DaemonProtocolError } from './types'
import type { DaemonEndpointIdentity, HelloMessage, HelloResponse } from './types'
import { addNodePtyRecoveryHint } from './node-pty-error-hints'

export type DaemonHelloRequest = {
  socket: Duplex
  token: string
  role: 'control' | 'stream'
  timeoutMs: number
  signal?: AbortSignal
  protocolVersion: number
  clientId: string
}

export function sendDaemonHello(
  request: DaemonHelloRequest
): Promise<DaemonEndpointIdentity | null> {
  const { socket, token, role, timeoutMs, protocolVersion, clientId, signal } = request
  return new Promise((resolve, reject) => {
    const hello: HelloMessage = {
      type: 'hello',
      version: protocolVersion,
      token,
      clientId,
      role
    }

    let buffer = Buffer.alloc(0)
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
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error?: Error, identity: DaemonEndpointIdentity | null = null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(identity)
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const newlineIdx = buffer.indexOf(10)
      if (newlineIdx === -1) {
        return
      }

      const line = buffer.subarray(0, newlineIdx).toString('utf8')
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
          // Preserve frames coalesced with hello until the role reader is installed.
          socket.pause()
          const remainder = buffer.subarray(newlineIdx + 1)
          if (remainder.length) {
            socket.unshift(remainder)
          }
          finish(undefined, identity)
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

    const onAbort = (): void => finish(new DaemonProtocolError('Disconnected'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
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

function isDaemonIdentityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseDaemonEndpointIdentity(identity: unknown): DaemonEndpointIdentity | null {
  if (!isDaemonIdentityRecord(identity)) {
    return null
  }
  if (
    typeof identity.pid !== 'number' ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.startedAtMs !== 'number' ||
    !Number.isFinite(identity.startedAtMs) ||
    identity.startedAtMs <= 0 ||
    typeof identity.launchNonce !== 'string' ||
    identity.launchNonce.length === 0
  ) {
    return null
  }
  if (
    (identity.linuxStartTicks !== undefined || identity.bootId !== undefined) &&
    (typeof identity.linuxStartTicks !== 'string' ||
      !/^\d+$/.test(identity.linuxStartTicks) ||
      typeof identity.bootId !== 'string' ||
      !identity.bootId ||
      /[\0\r\n]/.test(identity.bootId))
  ) {
    return null
  }
  return {
    ...(typeof identity.linuxStartTicks === 'string' && typeof identity.bootId === 'string'
      ? { linuxStartTicks: identity.linuxStartTicks, bootId: identity.bootId }
      : {}),
    pid: identity.pid,
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
      left.launchNonce === right.launchNonce &&
      left.linuxStartTicks === right.linuxStartTicks &&
      left.bootId === right.bootId)
  )
}
