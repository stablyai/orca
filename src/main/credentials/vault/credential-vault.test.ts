import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import { CredentialVault } from './credential-vault'

const fakeKeychain = {
  isEncryptionAvailable: () => true,
  describeProtectionGap: () => null,
  describeSealing: () => ({ kind: 'os-keychain' as const }),
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (cipher: Buffer) => cipher.toString()
}

it('keeps a saved secret out of summaries and preserves it when an edit leaves the value blank', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-credential-vault-'))
  const file = join(directory, 'vault.enc')
  try {
    setSecretStore(fakeKeychain)
    const login = { kind: 'login', name: 'Example', username: 'alex', website: 'example.test' }
    const saved = await new CredentialVault(file).save({ ...login, value: '  secret value  ' })
    expect(saved).toEqual({
      ok: true,
      value: [
        {
          id: expect.any(String),
          kind: 'login',
          name: 'Example',
          username: 'alex',
          website: 'example.test'
        }
      ]
    })
    if (!saved.ok) {
      throw new Error('Vault entry was not saved')
    }
    const id = saved.value[0].id
    const reopened = new CredentialVault(file)
    expect(await reopened.save({ ...login, id, name: 'Example work' })).toEqual({
      ok: true,
      value: [
        { id, kind: 'login', name: 'Example work', username: 'alex', website: 'example.test' }
      ]
    })
    expect(await reopened.readValue(id)).toEqual({ ok: true, value: '  secret value  ' })
    expect(await reopened.remove(id)).toEqual({ ok: true, value: [] })
    expect(await new CredentialVault(file).readValue(id)).toEqual({ ok: false, reason: 'missing' })
  } finally {
    _resetSecretStoreForTests()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('never replaces a sealed vault when encryption is weak or the old bytes cannot be opened', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-credential-vault-'))
  const file = join(directory, 'vault.enc')
  try {
    setSecretStore(fakeKeychain)
    const vault = new CredentialVault(file)
    const entry = { kind: 'secret', name: 'API', username: '', website: '', value: 'first token' }
    expect((await vault.save(entry)).ok).toBe(true)
    const before = readFileSync(file)
    setSecretStore({
      ...fakeKeychain,
      describeSealing: () => ({ kind: 'none', reason: 'weak backend' })
    })
    expect(await vault.save({ ...entry, value: 'second token' })).toEqual({
      ok: false,
      reason: 'unprotected'
    })
    setSecretStore({
      ...fakeKeychain,
      decryptString: () => {
        throw new Error('Wrong encryption key')
      }
    })
    expect(await vault.save({ ...entry, value: 'third token' })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(readFileSync(file)).toEqual(before)
  } finally {
    _resetSecretStoreForTests()
    rmSync(directory, { recursive: true, force: true })
  }
})
