import type { WebSocket } from 'ws'
import { E2EEChannel } from './e2ee-channel'
import { deriveSharedKey, encrypt, generateKeyPair } from '../../../shared/e2ee-crypto'
import { createRuntimeSnapshotReply } from './runtime-snapshot-reply'
import { RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY } from '../../../shared/remote-runtime-snapshot-compression'

export function createBandwidthChannel(compressed: boolean) {
  const server = generateKeyPair()
  const client = generateKeyPair()
  const key = deriveSharedKey(client.secretKey, server.publicKey)
  const sent: (string | Uint8Array)[] = []
  const failures: string[] = []
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string | Uint8Array) => sent.push(frame)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: E2EEChannel uses only these socket state/send members; real sockets are covered separately.
  const channel = new E2EEChannel(socket as unknown as WebSocket, {
    serverSecretKey: server.secretKey,
    resolveAuthenticatedDevice: () => ({
      deviceId: 'fixture',
      deviceToken: 'fixture-token',
      scope: 'runtime'
    }),
    onReady: () => {},
    onError: (_code, reason) => failures.push(reason)
  })
  channel.handleRawMessage(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(client.publicKey).toString('base64')
    })
  )
  channel.handleRawMessage(
    encrypt(
      JSON.stringify({
        type: 'e2ee_auth',
        deviceToken: 'fixture-token',
        clientCapabilities: compressed ? [RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY] : []
      }),
      key
    )
  )
  const replies = new Map<string, (response: string) => void>()
  let binaryReply: ((bytes: Uint8Array) => boolean | void) | undefined
  channel.onMessage((request, reply, sendBinary) => {
    replies.set(
      request,
      createRuntimeSnapshotReply(request, 'runtime', channel.clientCapabilities, reply)
    )
    binaryReply = sendBinary
  })
  for (const method of ['session.tabs.subscribeAll', 'files.list', 'files.read']) {
    channel.handleRawMessage(encrypt(method, key))
  }
  sent.length = 0
  return {
    key,
    sent,
    socket,
    failures,
    reply: (method: string, payload: string) => replies.get(method)!(payload),
    binary: (bytes: Uint8Array) => binaryReply!(bytes),
    close: () => channel.destroy()
  }
}
