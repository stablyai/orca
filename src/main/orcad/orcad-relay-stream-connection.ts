import type { Duplex } from 'node:stream'
import { beginRelayConnectHandshake } from '../../relay/relay-connect-handshake'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'

/** Takes ownership of an already-connected stream, never of its server or SSH connection. */
export async function connectOrcadRelayStream(options: {
  stream: Duplex
  incumbentVersion: string
  endpointCredential?: string
  signal?: AbortSignal
  timeoutMs?: number
  initialize: (multiplexer: SshChannelMultiplexer) => void
  assertAuthority?: () => void
}): Promise<SshChannelMultiplexer> {
  options = { ...options }
  const { stream, signal, assertAuthority } = options
  const timeoutMs = options.timeoutMs ?? 10_000
  return await new Promise((resolve, reject) => {
    let settled = false
    let cancelHandshake: (() => void) | undefined
    let multiplexer: SshChannelMultiplexer | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      cancelHandshake?.()
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      multiplexer?.dispose('connection_lost')
      stream.destroy()
      reject(error)
    }
    const onAbort = (): void => fail(signal?.reason ?? new Error('orcad_local_relay_aborted'))
    const assertCurrent = (): void => {
      signal?.throwIfAborted()
      assertAuthority?.()
      signal?.throwIfAborted()
      if (stream.destroyed || stream.readableEnded || stream.writableEnded) {
        throw new Error('orcad_local_relay_connection_closed')
      }
    }
    stream.on('error', (error) => {
      fail(error)
      stream.destroy()
    })
    stream.once('close', () => fail(new Error('orcad_local_relay_connection_closed')))
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (!options.incumbentVersion.trim()) {
        throw new Error('orcad_local_relay_endpoint_invalid')
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new Error('orcad_local_relay_timeout_invalid')
      }
      assertCurrent()
      timer = setTimeout(() => fail(new Error('orcad_local_relay_connect_timeout')), timeoutMs)
      cancelHandshake = beginRelayConnectHandshake(
        stream,
        options.incumbentVersion,
        {
          onRejected: fail,
          onAccepted: (leftover) => {
            if (settled) {
              return
            }
            let receive: ((data: Buffer) => void) | undefined
            const transport: MultiplexerTransport = {
              supportsWriteSettlement: true,
              write: (data, onSettled) =>
                stream.write(data, (error) => {
                  onSettled?.(error ? { ok: false, error } : { ok: true })
                }),
              onData: (callback) => {
                receive = callback
                stream.on('data', callback)
              },
              onClose: (callback) => stream.once('close', callback),
              onDrain: (callback) => {
                stream.on('drain', callback)
                return () => {
                  stream.off('drain', callback)
                }
              },
              pauseReads: () => {
                stream.pause()
              },
              resumeReads: () => {
                stream.resume()
              },
              close: () => {
                stream.destroy()
              }
            }
            try {
              assertCurrent()
              multiplexer = new SshChannelMultiplexer(transport)
              multiplexer.onDispose(() => fail(new Error('orcad_local_relay_connection_closed')))
              // Consumers must precede frames coalesced with handshake-ok.
              options.initialize(multiplexer)
              if (settled) {
                return
              }
              assertCurrent()
              if (leftover.length) {
                receive?.(leftover)
              }
              if (settled) {
                return
              }
              assertCurrent()
              settled = true
              cleanup()
              resolve(multiplexer)
            } catch (error) {
              fail(error)
            }
          }
        },
        options.endpointCredential
      )
      if (settled) {
        cancelHandshake()
      }
    } catch (error) {
      fail(error)
    }
  })
}
