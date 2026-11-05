import { expect, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { parsePairingCode } from '../../../shared/remote-runtime/pairing/pairing'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

export const TARGET = 'runtime:env-1'
export type Frame = Record<string, unknown>

export function pair(
  server: OrcaRuntimeRpcServer,
  scope: 'mobile' | 'runtime',
  name: string
): PairingOffer {
  const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  return parsePairingCode(offer.pairingUrl)!
}

export async function connectPhone(
  desktop: OrcaRuntimeRpcServer,
  name: string,
  cleanups: (() => Promise<void> | void)[]
) {
  const pairing = pair(desktop, 'mobile', name)
  const keys = generateKeyPair()
  const sharedKey = deriveSharedKey(keys.secretKey, publicKeyFromBase64(pairing.publicKeyB64))
  const ws = new WebSocket(pairing.endpoint)
  const frames: Frame[] = []
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
            JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }),
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
  cleanups.push(() => ws.close())
  const token = pairing.deviceToken
  return {
    token,
    deviceId: pairing.pairedDeviceId!,
    frames,
    binaries,
    close: () => ws.close(),
    send(
      id: string,
      method: string,
      params: unknown,
      executionHost: string | null = TARGET,
      expectedRuntimeSource?: { sourceId: string; runtimeId: string },
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
            executionHost: executionHost ?? undefined,
            ...(expectedRuntimeSource ? { expectedRuntimeSource } : {})
          }),
          sharedKey
        )
      )
    },
    next: (id: string, predicate: (frame: Frame) => boolean = () => true) =>
      vi.waitFor(() => {
        const frame = frames.find((candidate) => candidate.id === id && predicate(candidate))
        expect(frame).toBeDefined()
        return frame!
      })
  }
}
