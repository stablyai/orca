import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { PairedE2EEDowngradeError } from '../../../src/shared/paired-e2ee-client-handshake'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { createDirectSocketFraming } from './direct-socket-framing'

describe('legacy direct socket framing', () => {
  it('never sends legacy auth once another socket latched the host to v2 mid-handshake', async () => {
    const host = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
    let latched = false
    const sent: string[] = []
    let reportError!: (error: Error) => void
    const protocolError = new Promise<Error>((resolve) => {
      reportError = resolve
    })
    const onProtocolError = vi.fn((error: Error) => reportError(error))
    const framing = createDirectSocketFraming({
      framing: 'legacy',
      mayUseLegacy: () => !latched,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: legacy framing only calls send(); a wider use fails this test.
      socket: { send: (frame: string) => sent.push(frame) } as unknown as WebSocket,
      serverPublicKeyB64: Buffer.from(host.publicKey).toString('base64'),
      deviceToken: 'legacy-token',
      emitLog: vi.fn(),
      events: {
        onReadyAccepted: () => {
          // A v2 socket to the same host authenticates while this auth is being sealed.
          queueMicrotask(() => {
            latched = true
          })
        },
        onAuthenticated: vi.fn(),
        onText: vi.fn(),
        onBinary: vi.fn(),
        onAuthRejected: vi.fn(),
        onProtocolError
      }
    })
    framing.start()
    framing.handleInbound(JSON.stringify({ type: 'e2ee_ready' }))
    await expect(protocolError).resolves.toBeInstanceOf(PairedE2EEDowngradeError)
    expect(onProtocolError).toHaveBeenCalledOnce()

    expect(onProtocolError.mock.calls[0]?.[0]).toBeInstanceOf(PairedE2EEDowngradeError)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'e2ee_hello' })
    framing.dispose()
  })
})
