import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from '../../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../../shared/pairing'
import type { RpcRequest, RpcResponse } from './core'

/** Authenticated transport around the real dispatcher supplied by the integration fixture. */
export async function pairedRemovalReceiver(
  dispatch: (request: RpcRequest) => Promise<RpcResponse>
) {
  const keys = generateKeyPair()
  const deviceToken = 'removal-fixture'
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const connections: string[][] = []
  sockets.on('connection', (socket) => {
    const methods: string[] = []
    connections.push(methods)
    let key: Uint8Array | null = null
    let authenticated = false
    socket.on('message', (data) => {
      if (!key) {
        const hello: { publicKeyB64: string } = JSON.parse(data.toString())
        key = deriveSharedKey(keys.secretKey, Buffer.from(hello.publicKeyB64, 'base64'))
        socket.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = decrypt(data.toString(), key)
      if (!plaintext) {
        socket.close(4003)
        return
      }
      if (!authenticated) {
        const auth: { type: string; deviceToken: string } = JSON.parse(plaintext)
        if (auth.type !== 'e2ee_auth' || auth.deviceToken !== deviceToken) {
          socket.close(4001)
          return
        }
        authenticated = true
        socket.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), key))
        return
      }
      const request: RpcRequest = JSON.parse(plaintext)
      methods.push(request.method)
      const sharedKey = key
      void dispatch(request).then((response) =>
        socket.send(encrypt(JSON.stringify(response), sharedKey))
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP receiver')
  }
  return {
    port: address.port,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken,
      publicKeyB64: publicKeyToBase64(keys.publicKey),
      scope: 'runtime'
    }),
    connections,
    async close() {
      for (const socket of sockets.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
