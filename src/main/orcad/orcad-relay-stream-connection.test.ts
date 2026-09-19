import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  FrameDecoder,
  parseHandshakeMessage
} from '../../relay/protocol'
import { connectOrcadRelayStream } from './orcad-relay-stream-connection'

const version = 'saved-incumbent'
const accepted = encodeHandshakeFrame({ type: 'orca-relay-handshake-ok', version })
const notification = encodeJsonRpcFrame(
  { jsonrpc: '2.0', method: 'test.ready', params: { sequence: 1 } },
  1,
  0
)
const streams: Duplex[] = []
function peer(reply: Buffer | null = accepted): { stream: Duplex; writes: Buffer[] } {
  const writes: Buffer[] = []
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk))
      callback()
      if (writes.length === 1 && reply) {
        queueMicrotask(() => {
          if (!stream.destroyed) {
            stream.push(reply)
          }
        })
      }
    }
  })
  streams.push(stream)
  return { stream, writes }
}
afterEach(() => {
  for (const stream of streams.splice(0)) {
    stream.destroy()
  }
})

describe('already-connected incumbent relay stream', () => {
  it('supports transport write settlement', async () => {
    const { stream } = peer()
    const client = await connectOrcadRelayStream({
      stream,
      incumbentVersion: version,
      initialize: () => {}
    })
    expect(() => client.assertWriteSettlement()).not.toThrow()
    const settled = vi.fn()
    client.notifyWithSettlement('test.notify', {}, settled)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(settled.mock.calls[0][0]).toMatchObject({ outcome: 'accepted' })
  })

  it('pins initialization across the asynchronous handshake', async () => {
    const { stream } = peer()
    const initialize = vi.fn()
    const replaced = vi.fn()
    const options = { stream, incumbentVersion: version, initialize }
    const connection = connectOrcadRelayStream(options)
    options.initialize = replaced
    await connection
    expect(initialize).toHaveBeenCalledOnce()
    expect(replaced).not.toHaveBeenCalled()
  })
  it('authenticates the exact saved version and credential and installs consumers first', async () => {
    const { stream, writes } = peer(Buffer.concat([accepted, notification]))
    const observed = vi.fn()
    const client = await connectOrcadRelayStream({
      stream,
      incumbentVersion: version,
      endpointCredential: 'saved-secret',
      initialize: (mux) => mux.onNotification(observed)
    })
    const hello = vi.fn()
    new FrameDecoder(
      (frame) => hello(parseHandshakeMessage(frame.payload)),
      () => {}
    ).feed(writes[0])
    expect(hello).toHaveBeenCalledWith({
      type: 'orca-relay-handshake',
      version,
      endpointCredential: 'saved-secret'
    })
    expect(observed).toHaveBeenCalledWith('test.ready', { sequence: 1 })
    client.dispose()
    expect(stream.destroyed).toBe(true)
  })

  it.each([1, 2, 3, 4])('refuses authority loss at checkpoint %s', async (checkpoint) => {
    const { stream } = peer(Buffer.concat([accepted, notification]))
    const unrelated = peer(null).stream
    const initialize = vi.fn()
    let checks = 0
    await expect(
      connectOrcadRelayStream({
        stream,
        incumbentVersion: version,
        initialize,
        assertAuthority: () => {
          if (++checks === checkpoint) {
            throw new Error('authority lost')
          }
        }
      })
    ).rejects.toThrow('authority lost')
    expect(stream.destroyed).toBe(true)
    expect(unrelated.destroyed).toBe(false)
    expect(initialize).toHaveBeenCalledTimes(checkpoint < 3 ? 0 : 1)
  })

  it.each(['initialize', 'leftover', 'authority'] as const)(
    'refuses synchronous abort in %s',
    async (phase) => {
      const { stream } = peer(Buffer.concat([accepted, notification]))
      const controller = new AbortController()
      const abort = (): void => controller.abort(new Error('cancelled'))
      await expect(
        connectOrcadRelayStream({
          stream,
          incumbentVersion: version,
          signal: controller.signal,
          assertAuthority: phase === 'authority' ? abort : undefined,
          initialize: (mux) => {
            if (phase === 'initialize') {
              abort()
            }
            mux.onNotification(abort)
          }
        })
      ).rejects.toThrow('cancelled')
      expect(stream.destroyed).toBe(true)
    }
  )

  it('bounds a silent handshake', async () => {
    const { stream } = peer(null)
    await expect(
      connectOrcadRelayStream({
        stream,
        incumbentVersion: version,
        timeoutMs: 10,
        initialize: () => {}
      })
    ).rejects.toThrow('orcad_local_relay_connect_timeout')
    expect(stream.destroyed).toBe(true)
  })

  it('refuses a closed stream without waiting for a close event', async () => {
    const { stream } = peer(null)
    stream.destroy()
    await expect(
      connectOrcadRelayStream({ stream, incumbentVersion: version, initialize: () => {} })
    ).rejects.toThrow('orcad_local_relay_connection_closed')
  })

  it('does not return a client disposed by initialization', async () => {
    const { stream } = peer()
    await expect(
      connectOrcadRelayStream({
        stream,
        incumbentVersion: version,
        initialize: (mux) => mux.dispose()
      })
    ).rejects.toThrow('orcad_local_relay_connection_closed')
    expect(stream.destroyed).toBe(true)
  })
})
