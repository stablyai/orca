import { expect, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../../shared/e2ee-crypto'
import type { PairingOffer } from '../../../shared/pairing'

export type RelayTestFrame = Record<string, unknown>

/** A paired client on a legacy E2EE socket, recording every reply and binary frame it receives. */
export async function connectRelayTestClient(
  pairing: PairingOffer,
  options: { clientCapabilities: readonly string[]; defaultExecutionHost: string }
) {
  const keys = generateKeyPair()
  const sharedKey = deriveSharedKey(keys.secretKey, publicKeyFromBase64(pairing.publicKeyB64))
  const ws = new WebSocket(pairing.endpoint)
  const frames: RelayTestFrame[] = []
  const binaries: Uint8Array[] = []
  let authenticated = false
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) {
        binaries.push(decryptBytes(new Uint8Array(data), sharedKey)!)
        return
      }
      const text = data.toString()
      if (text.includes('e2ee_ready')) {
        ws.send(
          encrypt(
            JSON.stringify({
              type: 'e2ee_auth',
              deviceToken: pairing.deviceToken,
              clientCapabilities: options.clientCapabilities
            }),
            sharedKey
          )
        )
        return
      }
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(decrypt(text, sharedKey)!))
      if (!authenticated) {
        authenticated = frame.type === 'e2ee_authenticated'
        resolve()
        return
      }
      frames.push(frame)
    })
  })
  ws.once('open', () =>
    ws.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keys.publicKey) }))
  )
  await ready
  const token = pairing.deviceToken
  return {
    token,
    deviceId: pairing.pairedDeviceId!,
    frames,
    binaries,
    close: () => ws.close(),
    sendBinary: (bytes: Uint8Array) => ws.send(encryptBytes(bytes, sharedKey)),
    send(
      id: string,
      method: string,
      params: unknown,
      executionHost: string | null = options.defaultExecutionHost,
      untrustedScope?: { callerScope: string; clientKind: string }
    ) {
      ws.send(
        encrypt(
          JSON.stringify({
            ...untrustedScope,
            id,
            deviceToken: token,
            method,
            params,
            executionHost: executionHost ?? undefined
          }),
          sharedKey
        )
      )
    },
    next: (id: string, predicate: (frame: RelayTestFrame) => boolean = () => true) =>
      vi.waitFor(() => {
        const frame = frames.find((candidate) => candidate.id === id && predicate(candidate))
        expect(frame).toBeDefined()
        return frame!
      })
  }
}
