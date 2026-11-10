import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

import {
  createCloudReaderKeyStore,
  revokeCloudReaderKeyBestEffort,
  setCloudReaderKeyRevoker,
  type ReaderKeyCodec
} from './cloud-reader-key-store'
import { nodeSealedGrantPrimitives } from './sealed-grant-node'
import { base64ToBytes, bytesToBase64 } from '../../shared/cloud-workspaces/sealed-grant'

// Reversible stand-in for the OS keychain: the file must never hold the raw secret.
const codec: ReaderKeyCodec = {
  encrypt: (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString('hex')}`),
  decrypt: (sealed) => {
    const text = sealed.toString()
    if (!text.startsWith('sealed:')) {
      throw new Error('bad seal')
    }
    return Buffer.from(text.slice(7), 'hex').toString()
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reader-key-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const storeWith = (next: () => ReaderKeyCodec | null = () => codec) =>
  createCloudReaderKeyStore({
    pathFor: (profileId) => join(dir, profileId, 'key.enc'),
    codec: next
  })

describe('createCloudReaderKeyStore', () => {
  it('creates one key per profile lazily and keeps it sealed on disk', () => {
    const store = storeWith()
    const first = store.load('p1')
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.key.secretKey).toHaveLength(32)
    const derived = nodeSealedGrantPrimitives.x25519PublicKey(first.key.secretKey) as Uint8Array
    expect(first.key.publicKeyB64).toBe(bytesToBase64(derived))
    const file = readFileSync(join(dir, 'p1', 'key.enc'), 'utf8')
    expect(file).not.toContain(bytesToBase64(first.key.secretKey))
    expect(JSON.parse(file)).toMatchObject({ version: 1, format: 'electron-safe-storage-v1' })

    const second = store.load('p2')
    expect(second.ok && second.key.publicKeyB64).not.toBe(first.key.publicKeyB64)
  })

  it('reads the same key back after a restart', () => {
    const first = storeWith().load('p1')
    const again = storeWith().load('p1')
    expect(first.ok && again.ok).toBe(true)
    if (first.ok && again.ok) {
      expect(again.key.publicKeyB64).toBe(first.key.publicKeyB64)
      expect(base64ToBytes(bytesToBase64(again.key.secretKey))).toEqual(first.key.secretKey)
    }
  })

  it('is off with a reason when the OS keychain is missing, and writes nothing', () => {
    const store = storeWith(() => null)
    expect(store.load('p1')).toMatchObject({ ok: false, reason: 'keychain_unavailable' })
    expect(existsSync(join(dir, 'p1', 'key.enc'))).toBe(false)
  })

  it('replaces a key the keychain can no longer open', () => {
    const first = storeWith().load('p1')
    writeFileSync(
      join(dir, 'p1', 'key.enc'),
      JSON.stringify({ version: 1, format: 'electron-safe-storage-v1', ciphertext: 'AAAA' })
    )
    const replaced = storeWith().load('p1')
    expect(replaced.ok).toBe(true)
    expect(first.ok && replaced.ok && replaced.key.publicKeyB64 !== first.key.publicKeyB64).toBe(
      true
    )
  })

  it('clear drops the key from memory and disk (sign-out)', () => {
    const store = storeWith()
    const first = store.load('p1')
    store.clear('p1')
    expect(existsSync(join(dir, 'p1', 'key.enc'))).toBe(false)
    const next = store.load('p1')
    expect(first.ok && next.ok && next.key.publicKeyB64 !== first.key.publicKeyB64).toBe(true)
  })
})

describe('revokeCloudReaderKeyBestEffort', () => {
  afterEach(() => setCloudReaderKeyRevoker(null))

  it('runs the registered revoker with the timeout', async () => {
    const revoke = vi.fn(async (_timeoutMs: number) => {})
    setCloudReaderKeyRevoker(revoke)
    await revokeCloudReaderKeyBestEffort(500)
    expect(revoke).toHaveBeenCalledWith(500)
  })

  it('never blocks sign-out: a hung or failing revoke resolves within the timeout', async () => {
    setCloudReaderKeyRevoker(() => new Promise(() => {}))
    const started = Date.now()
    await revokeCloudReaderKeyBestEffort(30)
    expect(Date.now() - started).toBeLessThan(1_000)
    setCloudReaderKeyRevoker(async () => {
      throw new Error('offline')
    })
    await expect(revokeCloudReaderKeyBestEffort(30)).resolves.toBeUndefined()
    setCloudReaderKeyRevoker(null)
    await expect(revokeCloudReaderKeyBestEffort(30)).resolves.toBeUndefined()
  })
})

describe('peek', () => {
  it('returns the existing key and never creates one', () => {
    const store = storeWith()
    expect(store.peek('p1')).toBeNull()
    expect(existsSync(join(dir, 'p1', 'key.enc'))).toBe(false)
    const loaded = store.load('p1')
    const fresh = storeWith().peek('p1')
    expect(loaded.ok && fresh?.publicKeyB64 === loaded.key.publicKeyB64).toBe(true)
  })
})
