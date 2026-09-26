import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptCookieValueRaw } from './browser-cookie-decryption'
import type { EncryptionKeyResult } from './browser-cookie-sqlite'

const HOST_KEY = '.example.com'
const cbcKey = randomBytes(16)
const gcmKey = randomBytes(32)
const cbcKeyResult: EncryptionKeyResult = { mode: 'aes-128-cbc', keysByVersion: { v10: cbcKey } }
const gcmKeyResult: EncryptionKeyResult = { mode: 'aes-256-gcm', key: gcmKey }

function hostKeyHash(hostKey: string): Buffer {
  return createHash('sha256').update(hostKey).digest()
}

function encryptCbc(plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', cbcKey, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()])
}

function encryptGcm(plaintext: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', gcmKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), nonce, ciphertext, cipher.getAuthTag()])
}

describe('decryptCookieValueRaw host-key hash prefix', () => {
  it('strips the hash from a non-empty value', () => {
    const plaintext = Buffer.concat([hostKeyHash(HOST_KEY), Buffer.from('session-value')])
    expect(decryptCookieValueRaw(encryptCbc(plaintext), cbcKeyResult, HOST_KEY)).toEqual(
      Buffer.from('session-value')
    )
  })

  it('decrypts an empty value whose plaintext is only the hash', () => {
    const encrypted = encryptCbc(hostKeyHash(HOST_KEY))
    expect(decryptCookieValueRaw(encrypted, cbcKeyResult, HOST_KEY)).toEqual(Buffer.alloc(0))
  })

  it('decrypts an empty value on the Windows AES-GCM path', () => {
    const encrypted = encryptGcm(hostKeyHash(HOST_KEY))
    expect(decryptCookieValueRaw(encrypted, gcmKeyResult, HOST_KEY)).toEqual(Buffer.alloc(0))
  })

  it('keeps a pre-schema-24 value that has no prefix', () => {
    const encrypted = encryptCbc(Buffer.from('plain-legacy-value'))
    expect(decryptCookieValueRaw(encrypted, cbcKeyResult, HOST_KEY)).toEqual(
      Buffer.from('plain-legacy-value')
    )
  })

  it('still strips a binary prefix that is not this host key hash', () => {
    const plaintext = Buffer.concat([hostKeyHash('.other.com'), Buffer.from('value')])
    expect(decryptCookieValueRaw(encryptCbc(plaintext), cbcKeyResult, HOST_KEY)).toEqual(
      Buffer.from('value')
    )
  })
})
