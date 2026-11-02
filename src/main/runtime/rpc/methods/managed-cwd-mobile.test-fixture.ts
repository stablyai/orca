import { EventEmitter } from 'node:events'
import { expect, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { deriveSharedKey, decrypt, encrypt, generateKeyPair } from '../../../../shared/e2ee-crypto'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { AGENT_LAUNCH_RUNTIME_CAPABILITIES } from '../../../../shared/agent-launch-runtime-capability'
import {
  REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  serializeRemoteRuntimeRpcRequest
} from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { DeviceRegistry } from '../../device-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { MobileSocketWiring, type MobileSocketTransport } from '../mobile-socket-wiring'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { FILE_MUTATION_METHODS } from './files-mutation-methods'

// Same fake transport shape as mobile-socket-wiring.test; authentication/crypto/dispatch stay real.
class CwdSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: string[] = []
  readonly send = vi.fn((data: string | Buffer, callback?: (error?: Error) => void) => {
    this.sent.push(data.toString())
    callback?.()
  })
  readonly close = vi.fn()
}
class CwdTransport implements MobileSocketTransport {
  private receiveMessage: Parameters<MobileSocketTransport['onMessage']>[0] | undefined
  private receiveClose: Parameters<MobileSocketTransport['onConnectionClose']>[0] | undefined
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)
  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]) {
    this.receiveMessage = handler
  }
  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]) {
    this.receiveClose = handler
  }
  receive(ws: WebSocket, message: string) {
    this.receiveMessage?.(message, () => {}, ws)
  }
  disconnect(ws: WebSocket) {
    this.receiveClose?.(null, ws, false)
  }
}

export function managedCwdMobileFixture(runtime: OrcaRuntimeService, directory: string) {
  const registry = new DeviceRegistry(directory)
  let server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    methods: [...AGENT_LAUNCH_METHODS, ...FILE_MUTATION_METHODS],
    enableWebSocket: false
  })
  server['deviceRegistry'] = registry
  const desktop = generateKeyPair()
  const transport = new CwdTransport()
  let dispatch: Promise<void> | undefined
  const wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: { ...desktop, publicKeyB64: Buffer.from(desktop.publicKey).toString('base64') },
    onText: (socket, plaintext, reply, binary) => {
      dispatch = server['handleWebSocketMessage'](
        plaintext,
        reply,
        binary,
        undefined,
        socket.ws,
        null,
        socket
      )
    },
    onBinary: () => {},
    onClose: () => {}
  })
  server['mobileSocketWiring'] = wiring
  wiring.attachTransport(transport)
  const connections: WebSocket[] = []
  function connect(
    name: string,
    capabilities: readonly RuntimeCapability[] = AGENT_LAUNCH_RUNTIME_CAPABILITIES
  ) {
    const device = registry.addDevice(name, 'mobile')
    const phone = generateKeyPair()
    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    const socket = new CwdSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fake socket's OPEN/state/send/close/EventEmitter ports are consumed by these real protocol stages.
    const ws = socket as unknown as WebSocket
    connections.push(ws)
    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    transport.receive(
      ws,
      encrypt(
        JSON.stringify({
          type: 'e2ee_auth',
          deviceToken: device.token,
          clientCapabilities: capabilities
        }),
        sharedKey
      )
    )
    expect(transport.setClientId).toHaveBeenCalledWith(ws, device.deviceId)
    return {
      device,
      async send(method: string, params: unknown, token = device.token!) {
        const plaintext = serializeRemoteRuntimeRpcRequest({
          requestId: 'mobile-cwd',
          deviceToken: token,
          method,
          params
        })
        const sealed = encrypt(plaintext, sharedKey)
        const sealedBytes = Buffer.from(sealed, 'base64').byteLength
        expect(Buffer.byteLength(plaintext)).toBeLessThanOrEqual(
          REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES
        )
        expect(sealedBytes).toBe(Buffer.byteLength(plaintext) + 40)
        expect(Buffer.byteLength(sealed)).toBeLessThanOrEqual(
          REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES
        )
        const before = socket.sent.length
        dispatch = undefined
        transport.receive(ws, sealed)
        expect(dispatch).toBeDefined()
        await Promise.resolve(dispatch)
        const encryptedReply = socket.sent.at(-1)!
        expect(socket.sent.length).toBeGreaterThan(before)
        const reply = decrypt(encryptedReply, sharedKey)
        expect(reply).not.toBeNull()
        expect(Buffer.byteLength(reply!)).toBeLessThanOrEqual(
          REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
        )
        return {
          response: JSON.parse(reply!),
          metrics: {
            plaintext: Buffer.byteLength(plaintext),
            sealed: sealedBytes,
            base64: Buffer.byteLength(sealed),
            reply: Buffer.byteLength(reply!),
            sealedReply: Buffer.from(encryptedReply, 'base64').byteLength,
            base64Reply: Buffer.byteLength(encryptedReply)
          }
        }
      }
    }
  }
  return {
    registry,
    connect,
    restart(next: OrcaRuntimeService) {
      server = new OrcaRuntimeRpcServer({
        runtime: next,
        userDataPath: directory,
        methods: [...AGENT_LAUNCH_METHODS, ...FILE_MUTATION_METHODS],
        enableWebSocket: false
      })
      server['deviceRegistry'] = registry
      server['mobileSocketWiring'] = wiring
    },
    dispose() {
      for (const ws of connections) {
        transport.disconnect(ws)
      }
      wiring.dispose()
    }
  }
}
