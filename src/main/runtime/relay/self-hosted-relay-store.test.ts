import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../../shared/secret-store'
import { SelfHostedRelayStore } from './self-hosted-relay-store'

const settings = { url: 'https://relay.example.com/', accessKey: 'k'.repeat(64) }
const secrets = {
  isEncryptionAvailable: vi.fn(() => true),
  describeProtectionGap: vi.fn<() => string | null>(() => null),
  encryptString: vi.fn(() => Buffer.from('keyring-sealed-fixture')),
  decryptString: vi.fn(() => settings.accessKey)
}
let directory: string
let file: string
let store: SelfHostedRelayStore

beforeEach(() => {
  vi.resetAllMocks()
  secrets.isEncryptionAvailable.mockReturnValue(true)
  secrets.describeProtectionGap.mockReturnValue(null)
  secrets.encryptString.mockReturnValue(Buffer.from('keyring-sealed-fixture'))
  secrets.decryptString.mockReturnValue(settings.accessKey)
  setSecretStore(secrets)
  directory = mkdtempSync(join(tmpdir(), 'orca-relay-settings-'))
  file = join(directory, 'mobile-self-hosted-relay.json')
  store = new SelfHostedRelayStore(directory, true)
})

afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(directory, { recursive: true, force: true })
})

describe('SelfHostedRelayStore', () => {
  it('persists only the sealed key and reloads the same configuration identity', () => {
    expect(store.read()).toBeNull()
    const saved = store.save(settings)
    const disk = readFileSync(file, 'utf8')
    expect(disk).not.toContain(settings.accessKey)
    expect(disk).not.toContain(Buffer.from(settings.accessKey).toString('base64'))
    expect(secrets.encryptString).toHaveBeenCalledWith(settings.accessKey)
    expect(new SelfHostedRelayStore(directory, true).read()).toEqual(saved)
    expect(saved.config.relayDirectorUrl).toBe('https://relay.example.com')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(store.save(settings).configurationId).not.toBe(saved.configurationId)
    store.remove()
    expect(store.read()).toBeNull()
  })

  it.each(['locked', 'unprotected'] as const)(
    'preserves the prior file when the keyring is %s',
    (state) => {
      store.save(settings)
      const before = readFileSync(file, 'utf8')
      if (state === 'locked') {
        secrets.isEncryptionAvailable.mockReturnValue(false)
      } else {
        secrets.describeProtectionGap.mockReturnValue('basic_text')
      }
      expect(() => store.save({ ...settings, url: 'https://other.example.com' })).toThrow(
        'OS keyring'
      )
      expect(readFileSync(file, 'utf8')).toBe(before)
    }
  )

  it('does not overwrite a corrupt file during load or expose decryption errors', () => {
    writeFileSync(file, 'corrupt')
    expect(() => store.read()).toThrow('Could not unlock')
    expect(readFileSync(file, 'utf8')).toBe('corrupt')
    store.save(settings)
    secrets.decryptString.mockImplementation(() => {
      throw new Error(settings.accessKey)
    })
    expect(() => store.read()).toThrow('Could not unlock')
    expect(() => store.read()).not.toThrow(settings.accessKey)
  })

  it('rejects invalid input and encryption failure before replacing saved settings', () => {
    store.save(settings)
    const before = readFileSync(file, 'utf8')
    expect(() => store.save({ ...settings, url: 'http://relay.example.com' })).toThrow('HTTPS')
    secrets.encryptString.mockImplementation(() => {
      throw new Error(settings.accessKey)
    })
    expect(() => store.save(settings)).toThrow('Could not save the encrypted Relay settings')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
