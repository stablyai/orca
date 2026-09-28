import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { DaemonClientConnections } from './daemon-client-connections'
import type { DaemonFileLog } from './daemon-file-log'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { encodeNdjson } from './ndjson'

const PROTOCOL_VERSION = 42
const TOKEN = 'token'

class FakeSocket extends EventEmitter {
  destroyed = false
  readonly setKeepAlive = vi.fn()

  write(): boolean {
    return true
  }

  end(): void {
    this.destroy()
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.emit('close')
  }

  hello(role: 'control' | 'stream'): void {
    this.emit(
      'data',
      Buffer.from(
        encodeNdjson({
          type: 'hello',
          version: PROTOCOL_VERSION,
          token: TOKEN,
          role,
          clientId: 'client'
        })
      )
    )
  }
}

function connect() {
  const onStreamDisconnected = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connection path only reaches flush/clear/replaceStream on the batcher.
  const streamDataBatcher = {
    flush: vi.fn(),
    clear: vi.fn(),
    replaceStream: vi.fn()
  } as unknown as DaemonStreamDataBatcher
  const connections = new DaemonClientConnections({
    token: TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    identity: {
      launchNonce: null,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      spawnerExecPath: null
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only log() is called.
    log: { log: vi.fn() } as unknown as DaemonFileLog,
    streamDataBatcher,
    isAcceptingWork: () => true,
    onTransportChanged: vi.fn(),
    onConnectionAccepted: vi.fn(),
    onAuthenticatedPair: vi.fn(),
    onLastAuthenticatedClientDisconnected: vi.fn(),
    onControlRequest: vi.fn(),
    onControlReplaced: vi.fn(),
    onClientDisconnected: vi.fn(),
    onStreamDisconnected
  })
  const control = new FakeSocket()
  const stream = new FakeSocket()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: accept() uses only the EventEmitter surface plus write/end/destroy, all implemented by FakeSocket.
  connections.accept(control as unknown as Socket)
  control.hello('control')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  connections.accept(stream as unknown as Socket)
  stream.hello('stream')
  return { connections, control, onStreamDisconnected, stream }
}

describe('daemon stream socket keepalive', () => {
  it('probes the stream peer so a half-open link eventually closes', () => {
    const { stream } = connect()
    expect(stream.setKeepAlive).toHaveBeenCalledWith(true, 30_000)
  })

  it('reports the disconnect that a failed keepalive probe produces', () => {
    const { onStreamDisconnected, stream } = connect()
    expect(onStreamDisconnected).not.toHaveBeenCalled()
    // What a keepalive timeout looks like at this layer: the socket errors, then closes.
    stream.emit('error', new Error('ETIMEDOUT'))
    expect(onStreamDisconnected).toHaveBeenCalledWith('client')
  })
})
