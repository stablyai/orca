import { createConnection } from 'node:net'
import { posix } from 'node:path'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { classifyOrcadLocalRelaySocketError } from './orcad-local-relay-unavailable'
import { assertProfileLifetimeAdmission } from '../ssh/profile-lifetime-admission'
import { connectOrcadRelayStream } from './orcad-relay-stream-connection'

export function isOrcadLocalRelayEndpoint(
  endpoint: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    return /^\\\\[.?]\\pipe\\[^\\/\0]+$/i.test(endpoint)
  }
  return posix.isAbsolute(endpoint) && !endpoint.includes('\0')
}

/** Connects only to an incumbent endpoint; never deploys, replaces, or claims relay ownership. */
export async function connectOrcadLocalRelay(options: {
  endpoint: string
  incumbentVersion: string
  endpointCredential?: string
  timeoutMs?: number
  signal?: AbortSignal
  initialize: (multiplexer: SshChannelMultiplexer) => void
}): Promise<SshChannelMultiplexer> {
  options = { ...options }
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!isOrcadLocalRelayEndpoint(options.endpoint) || !options.incumbentVersion.trim()) {
    throw new Error('orcad_local_relay_endpoint_invalid')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('orcad_local_relay_timeout_invalid')
  }
  options.signal?.throwIfAborted()
  assertProfileLifetimeAdmission()
  const controller = new AbortController()
  const abort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) {
    abort()
  }
  const timer = setTimeout(
    () => controller.abort(new Error('orcad_local_relay_connect_timeout')),
    timeoutMs
  )
  try {
    const socket = createConnection({ path: options.endpoint })
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off('connect', connected)
        socket.off('close', closed)
        controller.signal.removeEventListener('abort', cancelled)
      }
      const connected = (): void => {
        cleanup()
        resolve()
      }
      const closed = (): void => {
        cleanup()
        reject(new Error('orcad_local_relay_connection_closed'))
      }
      const cancelled = (): void => {
        cleanup()
        socket.destroy()
        reject(controller.signal.reason)
      }
      socket.once('connect', connected)
      socket.once('close', closed)
      socket.on('error', (error) => {
        const classified = classifyOrcadLocalRelaySocketError(error)
        cleanup()
        controller.abort(classified)
        socket.destroy()
        reject(classified)
      })
      controller.signal.addEventListener('abort', cancelled, { once: true })
      if (controller.signal.aborted) {
        cancelled()
      }
    })
    return await connectOrcadRelayStream({
      stream: socket,
      incumbentVersion: options.incumbentVersion,
      endpointCredential: options.endpointCredential,
      signal: controller.signal,
      timeoutMs,
      initialize: options.initialize,
      assertAuthority: assertProfileLifetimeAdmission
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
