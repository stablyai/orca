import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import {
  configureBrowserPasswordVaults,
  deleteBrowserPasswordVault,
  getBrowserPasswordVault
} from './browser-password-vaults'

describe('deleteBrowserPasswordVault', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-browser-password-vaults-'))
    configureBrowserPasswordVaults(dir)
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`sealed:${text}`),
      decryptString: (cipher) => cipher.toString().replace(/^sealed:/, ''),
      describeProtectionGap: () => null
    })
  })

  afterEach(() => {
    chmodSync(join(dir, 'browser-passwords'), 0o700)
    _resetSecretStoreForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the file and forgets the cached vault', () => {
    getBrowserPasswordVault('default').add({
      origin: 'https://a.test',
      username: 'u',
      password: 'p'
    })
    expect(deleteBrowserPasswordVault('default')).toEqual({ ok: true, value: true })
    expect(getBrowserPasswordVault('default').list()).toEqual({ ok: true, value: [] })
  })

  it('deletes the captured vault after an Orca profile switch without touching its replacement', () => {
    const original = getBrowserPasswordVault('default')
    original.add({ origin: 'https://a.test', username: 'original', password: 'p' })
    configureBrowserPasswordVaults(join(dir, 'other-profile'))
    const replacement = getBrowserPasswordVault('default')
    replacement.add({ origin: 'https://b.test', username: 'replacement', password: 'p' })
    expect(deleteBrowserPasswordVault(original).ok).toBe(true)
    expect(existsSync(join(dir, 'browser-passwords', 'default.json'))).toBe(false)
    expect(replacement.list()).toMatchObject({ ok: true, value: [{ username: 'replacement' }] })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a failed delete and keeps serving the passwords that are still on disk',
    () => {
      getBrowserPasswordVault('default').add({
        origin: 'https://a.test',
        username: 'u',
        password: 'p'
      })
      chmodSync(join(dir, 'browser-passwords'), 0o500)

      expect(deleteBrowserPasswordVault('default')).toMatchObject({
        ok: false,
        reason: 'unavailable'
      })
      expect(existsSync(join(dir, 'browser-passwords', 'default.json'))).toBe(true)
      const listed = getBrowserPasswordVault('default').list()
      expect(listed.ok && listed.value.map((entry) => entry.username)).toEqual(['u'])
    }
  )
})
