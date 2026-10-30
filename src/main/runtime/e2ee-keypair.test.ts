import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { loadOrCreateE2EEKeypair } from './e2ee-keypair'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

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
})
