import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptCookieValueRaw } from './browser-cookie-decryption'
import type { EncryptionKeyResult } from './chromium-encryption-key-contract'

const HOST_KEY = '.example.com'
const cbcKey = randomBytes(16)

const cbcKeyResult: EncryptionKeyResult = { mode: 'aes-128-cbc', keysByVersion: { v10: cbcKey } }

function hostKeyHash(hostKey: string): Buffer {
  return createHash('sha256').update(hostKey).digest()
}

function encryptCbc(plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', cbcKey, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()])
}

describe('decryptCookieValueRaw host-key hash prefix', () => {
  it('decrypts an empty value whose plaintext is only the hash', () => {
    const encrypted = encryptCbc(hostKeyHash(HOST_KEY))
    expect(decryptCookieValueRaw(encrypted, cbcKeyResult, HOST_KEY)).toEqual(Buffer.alloc(0))
  })
})
