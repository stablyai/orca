import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { connectOrcadRelayStream } from '../orcad/orcad-relay-stream-connection'

type SourceConnection = Pick<
  SshConnection,
  | 'getClient'
  | 'getTarget'
  | 'getState'
  | 'getTransportGeneration'
  | 'usesSystemSshTransport'
  | 'forwardStreamLocal'
>

/** Bare source transport only: no deployment, owner claim, provider or PTY restoration. */
export async function connectOrcadSavedSshSource(options: {
  connection: SourceConnection
  targetId: string
  source: { endpoint: string; incumbentVersion: string; endpointCredential: string }
  signal: AbortSignal
  assertAuthority: () => void
  initialize: (mux: SshChannelMultiplexer) => void
  timeoutMs?: number
}) {
  const { connection, signal, assertAuthority, initialize, targetId } = options
  const source = { ...options.source }
  const timeoutMs = options.timeoutMs ?? 10_000
  if (
    !source.endpoint.startsWith('/') ||
    source.endpoint.includes('\0') ||
    source.endpoint.length > 4096 ||
    !source.incumbentVersion.trim() ||
    source.incumbentVersion.length > 256 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(source.endpointCredential) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new Error('orcad_saved_source_connection_invalid')
  }
  const client = connection.getClient()
  const transportGeneration = connection.getTransportGeneration()
  let channel: ClientChannel | undefined
  let mux: SshChannelMultiplexer | undefined
  let disposed = false
  let removeDispose = () => {}
  const dispose = () => {
    if (!disposed) {
      disposed = true
      signal.removeEventListener('abort', dispose)
      removeDispose()
    }
    mux?.dispose()
    channel?.destroy()
  }
  const assertCurrent = () => {
    signal.throwIfAborted()
    assertAuthority()
    if (
      disposed ||
      !client ||
      connection.getClient() !== client ||
      connection.getTarget().id !== targetId ||
      connection.getState().status !== 'connected' ||
      connection.usesSystemSshTransport() ||
      connection.getTransportGeneration() !== transportGeneration ||
      !Number.isSafeInteger(transportGeneration) ||
      transportGeneration < 0 ||
      mux?.isDisposed()
    ) {
      throw new Error('orcad_saved_source_connection_changed')
    }
  }
  assertCurrent()
  signal.addEventListener('abort', dispose, { once: true })
  const opening = new AbortController()
  const abortOpening = () => opening.abort(signal.reason)
  signal.addEventListener('abort', abortOpening, { once: true })
  const timer = setTimeout(
    () => opening.abort(new Error('orcad_saved_source_connection_timeout')),
    timeoutMs
  )
  try {
    channel = await new Promise<ClientChannel>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, accepted?: ClientChannel) => {
        if (settled) {
          accepted?.destroy()
          return
        }
        settled = true
        opening.signal.removeEventListener('abort', onAbort)
        if (error !== undefined) {
          reject(error)
        } else {
          resolve(accepted!)
        }
      }
      const onAbort = () => finish(opening.signal.reason)
      opening.signal.addEventListener('abort', onAbort, { once: true })
      try {
        opening.signal.throwIfAborted()
        assertCurrent()
        connection.forwardStreamLocal(client!, source.endpoint, (error, accepted) => {
          if (error) {
            finish(error)
            return
          }
          try {
            opening.signal.throwIfAborted()
            assertCurrent()
            finish(undefined, accepted)
          } catch (error) {
            accepted?.destroy()
            finish(error)
          }
        })
      } catch (error) {
        finish(error)
      }
    })
    assertCurrent()
    mux = await connectOrcadRelayStream({
      stream: channel,
      incumbentVersion: source.incumbentVersion,
      endpointCredential: source.endpointCredential,
      signal: opening.signal,
      timeoutMs,
      assertAuthority: assertCurrent,
      initialize: (admitted) => {
        mux = admitted
        removeDispose = admitted.onDispose(dispose)
        assertCurrent()
        initialize(admitted)
        assertCurrent()
      }
    })
    opening.signal.throwIfAborted()
    assertCurrent()
    return { mux, connection, transportGeneration, assertCurrent, dispose }
  } catch (error) {
    dispose()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abortOpening)
  }
}
