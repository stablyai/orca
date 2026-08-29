import { randomBytes, randomUUID } from 'node:crypto'
import { encodePairingOffer, type PairingOffer } from '../shared/pairing'
import { generateKeyPair, publicKeyToBase64 } from '../shared/e2ee-crypto'

export type DesktopHostPairingMaterial = {
  runtimeId: string
  deviceToken: string
  publicKey: Uint8Array
  secretKey: Uint8Array
  publicKeyB64: string
  offer: PairingOffer
  pairingUrl: string
}

export function createDesktopHostPairingMaterial(endpoint: string): DesktopHostPairingMaterial {
  const keyPair = generateKeyPair()
  const deviceToken = randomBytes(24).toString('hex')
  const publicKeyB64 = publicKeyToBase64(keyPair.publicKey)
  const offer: PairingOffer = {
    v: 2,
    endpoint,
    deviceToken,
    publicKeyB64
  }
  return {
    runtimeId: randomUUID(),
    deviceToken,
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    publicKeyB64,
    offer,
    pairingUrl: encodePairingOffer(offer)
  }
}
