import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { loadOrCreateE2EEKeypair } from './e2ee-keypair'
import { DEVICE_REGISTRY_FILENAME, E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

describe('loadOrCreateE2EEKeypair', () => {
  it('advertises the public key derived from the stored secret, leaving the file untouched', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-e2ee-'))
    const real = nacl.box.keyPair()
    const other = nacl.box.keyPair()
    const file = join(userDataPath, E2EE_KEYPAIR_FILENAME)
    const contents = JSON.stringify({
      v: 1,
      publicKeyB64: Buffer.from(other.publicKey).toString('base64'),
      secretKeyB64: Buffer.from(real.secretKey).toString('base64')
    })
    writeFileSync(file, contents, { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const keypair = loadOrCreateE2EEKeypair(userDataPath)

    expect(keypair.publicKeyB64).toBe(Buffer.from(real.publicKey).toString('base64'))
    expect(Buffer.from(keypair.publicKey).equals(Buffer.from(real.publicKey))).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(contents)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  describe('host binding', () => {
    function seed(hostBinding?: string) {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-e2ee-'))
      const pair = nacl.box.keyPair()
      const publicKeyB64 = Buffer.from(pair.publicKey).toString('base64')
      writeFileSync(
        join(userDataPath, E2EE_KEYPAIR_FILENAME),
        JSON.stringify({
          v: 1,
          publicKeyB64,
          secretKeyB64: Buffer.from(pair.secretKey).toString('base64'),
          ...(hostBinding ? { hostBinding } : {})
        }),
        { mode: 0o600 }
      )
      writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), '{"devices":[]}', { mode: 0o600 })
      return { userDataPath, publicKeyB64 }
    }
    const storedFile = (userDataPath: string) =>
      JSON.parse(readFileSync(join(userDataPath, E2EE_KEYPAIR_FILENAME), 'utf8'))

    it('keeps a key minted on this machine', () => {
      const { userDataPath, publicKeyB64 } = seed('host-a')
      expect(loadOrCreateE2EEKeypair(userDataPath, 'host-a').publicKeyB64).toBe(publicKeyB64)
      expect(existsSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))).toBe(true)
    })

    it('adopts a key that predates the binding without replacing it', () => {
      const { userDataPath, publicKeyB64 } = seed()
      expect(loadOrCreateE2EEKeypair(userDataPath, 'host-a').publicKeyB64).toBe(publicKeyB64)
      expect(storedFile(userDataPath)).toMatchObject({ publicKeyB64, hostBinding: 'host-a' })
      expect(existsSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))).toBe(true)
    })

    it('keeps a bound key where this machine has no trustworthy identity', () => {
      const { userDataPath, publicKeyB64 } = seed('host-a')
      expect(loadOrCreateE2EEKeypair(userDataPath, null).publicKeyB64).toBe(publicKeyB64)
      expect(storedFile(userDataPath).hostBinding).toBe('host-a')
    })

    it('mints a new key, and sets the old pairings aside, on a machine cloned from another', () => {
      const { userDataPath, publicKeyB64 } = seed('host-a')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const keypair = loadOrCreateE2EEKeypair(userDataPath, 'host-b')

      expect(keypair.publicKeyB64).not.toBe(publicKeyB64)
      expect(storedFile(userDataPath)).toMatchObject({
        publicKeyB64: keypair.publicKeyB64,
        hostBinding: 'host-b'
      })
      expect(existsSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))).toBe(false)
      const setAside = (name: string) =>
        readdirSync(userDataPath).filter((file) => file.startsWith(`${name}.from-other-host-`))
      const [oldKey] = setAside(E2EE_KEYPAIR_FILENAME)
      expect(JSON.parse(readFileSync(join(userDataPath, oldKey), 'utf8')).publicKeyB64).toBe(
        publicKeyB64
      )
      expect(setAside(DEVICE_REGISTRY_FILENAME)).toHaveLength(1)
      // The replacement is bound here, so the next start keeps it.
      expect(loadOrCreateE2EEKeypair(userDataPath, 'host-b').publicKeyB64).toBe(
        keypair.publicKeyB64
      )
      warn.mockRestore()
    })
  })
})
