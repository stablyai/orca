import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { encodeNdjson } from './ndjson'
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
}

export function sendDaemonHello(
  request: DaemonHelloRequest
): Promise<DaemonEndpointIdentity | null> {
  const { socket, token, role, timeoutMs, protocolVersion, clientId } = request
  return new Promise((resolve, reject) => {
    const hello: HelloMessage = {
      type: 'hello',
      version: protocolVersion,
      token,
      clientId,
      role
    }

    let buffer = ''
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
    // Why: daemon socket chunks can split emoji/box-drawing UTF-8 bytes.
    // Decoding each Buffer independently would permanently inject U+FFFD.
    const decoder = new StringDecoder('utf8')
    const onData = (chunk: Buffer): void => {
      buffer += decoder.write(chunk)
      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx === -1) {
        return
      }

      const line = buffer.slice(0, newlineIdx)
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

// Why optional unknowns: an older or newer daemon's extra fields of another shape are dropped, not fatal.
const daemonEndpointIdentitySchema = z.object({
  pid: z.number().refine((pid) => Number.isSafeInteger(pid) && pid > 0),
  startedAtMs: z.number().refine((startedAtMs) => Number.isFinite(startedAtMs) && startedAtMs > 0),
  launchNonce: z.string().min(1),
  entryPath: z.unknown().optional(),
  appVersion: z.unknown().optional(),
  spawnerExecPath: z.unknown().optional(),
  claudeAccountFunction: z.unknown().optional()
})

function parseDaemonEndpointIdentity(value: unknown): DaemonEndpointIdentity | null {
  const parsed = daemonEndpointIdentitySchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const identity = parsed.data
  const text = (field: unknown): string | null =>
    typeof field === 'string' && field.length > 0 ? field : null
  const entryPath = text(identity.entryPath)
  const appVersion = text(identity.appVersion)
  const spawnerExecPath = text(identity.spawnerExecPath)
  return {
    pid: identity.pid,
    startedAtMs: identity.startedAtMs,
    launchNonce: identity.launchNonce,
    ...(entryPath ? { entryPath } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(spawnerExecPath ? { spawnerExecPath } : {}),
    ...(identity.claudeAccountFunction === true ? { claudeAccountFunction: true as const } : {})
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
