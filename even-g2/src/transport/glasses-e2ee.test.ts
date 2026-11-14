import { describe, expect, it } from 'vitest'
import {
  decryptBytes,
  decryptText,
  deriveSharedKey,
  encryptText,
  generateKeyPair,
  MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS,
  publicKeyFromBase64,
  publicKeyToBase64
} from './glasses-e2ee'
// R7 interop pin: even-g2's browser-flavored e2ee must decrypt/encrypt identically to
// src/shared/e2ee-crypto.ts (the Node/Buffer canonical implementation the desktop runs). This
// file is fine to import here even though production transport code must not (see
// pairing-code-decode.ts / orca-socket-client.ts) — vitest runs under real Node, so `Buffer`
// exists; only the browser bundle can't have it.
import * as sharedE2ee from '../../../src/shared/e2ee-crypto'

function derivePair() {
  const a = generateKeyPair()
  const b = generateKeyPair()
  return {
    aShared: deriveSharedKey(a.secretKey, b.publicKey),
    bShared: deriveSharedKey(b.secretKey, a.publicKey)
  }
}

describe('glasses-e2ee', () => {
  it('round-trips text through encryptText/decryptText', () => {
    const { aShared, bShared } = derivePair()
    const encrypted = encryptText('hello glasses', aShared)
    expect(decryptText(encrypted, bShared)).toBe('hello glasses')
  })

  it('returns null when the ciphertext is tampered with', () => {
    const { aShared, bShared } = derivePair()
    const encrypted = encryptText('hello glasses', aShared)
    const tampered = encrypted.slice(0, -4) + (encrypted.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
    expect(decryptText(tampered, bShared)).toBeNull()
  })

  it('returns null for a bundle too short to contain nonce+overhead', () => {
    const { bShared } = derivePair()
    expect(decryptBytes(new Uint8Array(4), bShared)).toBeNull()
  })

  it('decryptText returns null (not a throw) for malformed base64', () => {
    const { bShared } = derivePair()
    expect(() => decryptText('!!!not-valid-base64!!!', bShared)).not.toThrow()
    expect(decryptText('!!!not-valid-base64!!!', bShared)).toBeNull()
  })

  it('decryptText returns null for input over the max encoded size, without calling atob', () => {
    const { bShared } = derivePair()
    const oversized = 'A'.repeat(MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS + 4)
    expect(() => decryptText(oversized, bShared)).not.toThrow()
    expect(decryptText(oversized, bShared)).toBeNull()
  })

  it('decryptBytes returns null (not a throw) for a malformed/oversized nonce+ciphertext bundle', () => {
    const { bShared } = derivePair()
    const garbage = new Uint8Array(1024).fill(7)
    expect(() => decryptBytes(garbage, bShared)).not.toThrow()
    expect(decryptBytes(garbage, bShared)).toBeNull()
  })

  it('publicKeyFromBase64 throws unless exactly 32 bytes', () => {
    const kp = generateKeyPair()
    expect(() => publicKeyFromBase64(publicKeyToBase64(kp.publicKey))).not.toThrow()
    expect(() => publicKeyFromBase64(btoa('too-short'))).toThrow(/expected 32 bytes/)
  })

  it('publicKeyToBase64 round-trips through publicKeyFromBase64', () => {
    const kp = generateKeyPair()
    const b64 = publicKeyToBase64(kp.publicKey)
    expect(publicKeyFromBase64(b64)).toEqual(kp.publicKey)
  })

  describe('interop with src/shared/e2ee-crypto', () => {
    it('src/shared can decrypt what glasses-e2ee encrypts', () => {
      const g2 = generateKeyPair()
      const desktop = sharedE2ee.generateKeyPair()
      const g2Shared = deriveSharedKey(g2.secretKey, desktop.publicKey)
      const desktopShared = sharedE2ee.deriveSharedKey(desktop.secretKey, g2.publicKey)

      const encrypted = encryptText('from-g2', g2Shared)
      expect(sharedE2ee.decrypt(encrypted, desktopShared)).toBe('from-g2')
    })

    it('glasses-e2ee can decrypt what src/shared encrypts', () => {
      const g2 = generateKeyPair()
      const desktop = sharedE2ee.generateKeyPair()
      const g2Shared = deriveSharedKey(g2.secretKey, desktop.publicKey)
      const desktopShared = sharedE2ee.deriveSharedKey(desktop.secretKey, g2.publicKey)

      const encrypted = sharedE2ee.encrypt('from-desktop', desktopShared)
      expect(decryptText(encrypted, g2Shared)).toBe('from-desktop')
    })

    it('publicKeyToBase64 output from each side is accepted by the other side', () => {
      const g2 = generateKeyPair()
      expect(sharedE2ee.publicKeyFromBase64(publicKeyToBase64(g2.publicKey))).toEqual(g2.publicKey)
      const desktop = sharedE2ee.generateKeyPair()
      expect(publicKeyFromBase64(sharedE2ee.publicKeyToBase64(desktop.publicKey))).toEqual(
        desktop.publicKey
      )
    })
  })
})
