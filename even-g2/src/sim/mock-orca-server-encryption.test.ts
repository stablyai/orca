import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { base64ToBytes, decryptText, encryptText } from './mock-orca-server-encryption'

describe('base64ToBytes', () => {
  it('decodes valid base64', () => {
    expect(base64ToBytes(btoa('abc'))).toEqual(new Uint8Array([97, 98, 99]))
  })

  it('throws on malformed base64 input (unguarded — decryptText is the caller that must guard it)', () => {
    expect(() => base64ToBytes('not valid base64!!! ***')).toThrow()
  })
})

describe('decryptText', () => {
  const sharedKey = nacl.randomBytes(nacl.box.sharedKeyLength)

  it('round-trips through encryptText', () => {
    const encoded = encryptText('hello', sharedKey)
    expect(decryptText(encoded, sharedKey)).toBe('hello')
  })

  it('fails closed (returns null, does not throw) on a malformed base64 frame', () => {
    expect(() => decryptText('not valid base64!!! ***', sharedKey)).not.toThrow()
    expect(decryptText('not valid base64!!! ***', sharedKey)).toBeNull()
  })

  it('returns null for a too-short (but validly base64) frame', () => {
    expect(decryptText(btoa('short'), sharedKey)).toBeNull()
  })
})
