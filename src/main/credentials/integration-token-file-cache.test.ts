import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import { createIntegrationTokenFileCache } from './integration-token-file-cache'

let directory = ''
const decrypt = vi.fn((value: Buffer) => value.toString('utf-8'))

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-token-file-cache-'))
  decrypt.mockReset().mockImplementation((value) => value.toString('utf-8'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: decrypt,
    describeProtectionGap: () => null
  })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function filePath(id: string): string {
  return join(directory, `${id}.enc`)
}

function createCache() {
  return createIntegrationTokenFileCache({ service: 'Jira', filePath })
}

describe('integration token file cache', () => {
  it('clears an old decryption error after external replacement without prompting on status', async () => {
    const cache = createCache()
    writeFileSync(filePath('site'), Buffer.from([0xff, 0xfe]))
    decrypt.mockImplementation(() => {
      throw new Error('Keychain access denied')
    })
    await expect(cache.read('site')).rejects.toThrow('Could not decrypt')
    writeFileSync(filePath('site'), 'replacement-token')
    expect(await cache.has('site')).toBe(true)
    expect(await cache.error('site')).toBeUndefined()
    expect(await cache.read('site')).toBe('replacement-token')
  })

  it('retries after an external rotation during decryption', async () => {
    const cache = createCache()
    writeFileSync(filePath('site'), 'old-token')
    decrypt.mockImplementationOnce((value) => {
      writeFileSync(filePath('site'), 'replacement-token')
      return value.toString('utf-8')
    })
    expect(await cache.read('site')).toBe('replacement-token')
    expect(await cache.read('site')).toBe('replacement-token')
  })

  it('uses the backing path as part of a credential identity', async () => {
    let path = filePath('first')
    writeFileSync(path, 'first-token')
    const cache = createIntegrationTokenFileCache({ service: 'Linear', filePath: () => path })
    expect(await cache.read('workspace')).toBe('first-token')
    path = filePath('second')
    expect(await cache.has('workspace')).toBe(false)
    expect(await cache.read('workspace')).toBeNull()
    writeFileSync(path, 'second-token')
    expect(await cache.read('workspace')).toBe('second-token')
  })

  it('forgets a locally written token so an overlapping external replacement wins', async () => {
    const cache = createCache()
    writeFileSync(filePath('site'), 'old-token')
    await cache.read('site')
    writeFileSync(filePath('site'), 'our-token')
    cache.forget('site')
    writeFileSync(filePath('site'), 'their-token')
    expect(await cache.read('site')).toBe('their-token')
    cache.clear()
    expect(await cache.read('site', false)).toBeNull()
  })
})
