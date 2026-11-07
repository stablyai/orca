// Test support (not exercised in production): a minimal E2EE handshake + status.get/worktree.ps/
// notifications.subscribe responder, reusing src/sim/mock-orca-server-encryption.ts's wire
// framing helpers. Lets host-session-manager.test.ts and app-shell.test.ts drive a real
// OrcaSocketClient through an actual handshake (with a configurable compat verdict) instead of
// hand-rolling an RpcPort stub, without pulling in src/sim's fixture-heavy MockOrcaServer.
import nacl from 'tweetnacl'
import {
  base64ToBytes,
  bytesToBase64,
  decryptText,
  encryptText
} from '../sim/mock-orca-server-encryption'
import { MEMORY_SOCKET_READY_STATE, type MemorySocketLike } from '../sim/memory-socket-pair'

export type OrcaHandshakeTestServerOptions = {
  deviceToken: string
  protocolVersion: number
  minCompatibleMobileVersion: number
}

export class OrcaHandshakeTestServer {
  readonly publicKeyB64: string
  readonly calledMethods: string[] = []
  private readonly keyPair = nacl.box.keyPair()
  private readonly options: OrcaHandshakeTestServerOptions

  constructor(options: OrcaHandshakeTestServerOptions) {
    this.options = options
    this.publicKeyB64 = bytesToBase64(this.keyPair.publicKey)
  }

  attach(socket: MemorySocketLike): void {
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    socket.onmessage = (event) => {
      const data = event.data
      if (typeof data !== 'string') {
        return
      }
      if (!sharedKey) {
        const hello = JSON.parse(data) as { publicKeyB64: string }
        sharedKey = nacl.box.before(base64ToBytes(hello.publicKeyB64), this.keyPair.secretKey)
        socket.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      if (!authenticated) {
        const auth = JSON.parse(decryptText(data, sharedKey)!) as { deviceToken: string }
        if (auth.deviceToken !== this.options.deviceToken) {
          socket.send(
            encryptText(
              JSON.stringify({ type: 'e2ee_error', error: { code: 'unauthorized' } }),
              sharedKey
            )
          )
          socket.close()
          return
        }
        authenticated = true
        socket.send(encryptText(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        return
      }
      const request = JSON.parse(decryptText(data, sharedKey)!) as { id: string; method: string }
      this.calledMethods.push(request.method)
      this.respond(socket, sharedKey, request)
    }
  }

  private respond(
    socket: MemorySocketLike,
    sharedKey: Uint8Array,
    request: { id: string; method: string }
  ): void {
    const send = (result: unknown, streaming?: true): void => {
      if (socket.readyState !== MEMORY_SOCKET_READY_STATE.OPEN) {
        return
      }
      const response: Record<string, unknown> = {
        id: request.id,
        ok: true,
        result,
        _meta: { runtimeId: 'test' }
      }
      if (streaming) {
        response.streaming = true
      }
      socket.send(encryptText(JSON.stringify(response), sharedKey))
    }
    switch (request.method) {
      case 'status.get':
        send({
          protocolVersion: this.options.protocolVersion,
          minCompatibleMobileVersion: this.options.minCompatibleMobileVersion
        })
        return
      case 'worktree.ps':
        send({ worktrees: [] })
        return
      case 'notifications.subscribe':
        send({ type: 'ready' }, true)
        return
      default:
        send({}) // runtime.clientCapabilities.update and anything else: response is discarded
    }
  }
}
