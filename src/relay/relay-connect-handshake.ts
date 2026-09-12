import type { Duplex } from 'node:stream'
import { FrameDecoder, MessageType, encodeHandshakeFrame, parseHandshakeMessage } from './protocol'

export class RelayConnectHandshakeError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 42 | 43 = 1
  ) {
    super(message)
    this.name = 'RelayConnectHandshakeError'
  }
}

/** Shared by the CLI bridge and in-process host clients; never exits the caller. */
export function beginRelayConnectHandshake(
  socket: Duplex,
  version: string,
  callbacks: {
    onAccepted: (leftover: Buffer) => void
    onRejected: (error: RelayConnectHandshakeError) => void
  },
  endpointCredential?: string
): () => void {
  let settled = false
  const finish = (): void => {
    settled = true
    socket.removeListener('data', onData)
    decoder.reset()
  }
  const reject = (error: RelayConnectHandshakeError): void => {
    if (settled) {
      return
    }
    finish()
    callbacks.onRejected(error)
  }
  const decoder = new FrameDecoder(
    (frame) => {
      if (settled) {
        return
      }
      if (frame.type !== MessageType.Handshake) {
        reject(new RelayConnectHandshakeError('Protocol violation: expected Handshake frame'))
        return
      }
      let message: ReturnType<typeof parseHandshakeMessage>
      try {
        message = parseHandshakeMessage(frame.payload)
      } catch {
        reject(new RelayConnectHandshakeError('Could not parse handshake reply'))
        return
      }
      if (message.type === 'orca-relay-handshake-mismatch') {
        reject(
          new RelayConnectHandshakeError(
            `Relay handshake version mismatch: expected=${message.expected}, got=${message.got}`,
            42
          )
        )
        return
      }
      if (message.type === 'orca-relay-handshake-credential-mismatch') {
        reject(new RelayConnectHandshakeError('Endpoint credential refused by daemon', 43))
        return
      }
      if (message.type !== 'orca-relay-handshake-ok') {
        reject(new RelayConnectHandshakeError('Unexpected handshake reply type'))
        return
      }
      if (message.version !== version) {
        reject(
          new RelayConnectHandshakeError(
            `Relay acknowledged a different version: expected=${version}, got=${message.version}`,
            42
          )
        )
        return
      }
      const leftover = decoder.drain()
      finish()
      callbacks.onAccepted(leftover)
    },
    () => reject(new RelayConnectHandshakeError('Handshake decode error'))
  )
  const onData = (chunk: Buffer): void => {
    if (!settled) {
      decoder.feed(chunk)
    }
  }
  socket.on('data', onData)
  try {
    socket.write(
      encodeHandshakeFrame({
        type: 'orca-relay-handshake',
        version,
        ...(endpointCredential ? { endpointCredential } : {})
      })
    )
  } catch {
    reject(new RelayConnectHandshakeError('Could not write relay handshake'))
  }
  return finish
}
