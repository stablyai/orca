import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../shared/secret-store'
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
  it('bounds decrypted credentials at 128 entries', () => {
    const cache = createCache()
    for (let index = 0; index < 132; index += 1) {
      const id = `credential-${index}`
      writeFileSync(filePath(id), `token-${index}`)
      expect(cache.read(id)).toBe(`token-${index}`)
    }
    expect(cache.read('credential-131', false)).toBe('token-131')
    expect(cache.read('credential-0', false)).toBeNull()
    expect(decrypt).toHaveBeenCalledTimes(132)
  })

  it('keeps recently used credentials when the bound evicts the oldest entry', () => {
    const cache = createCache()
    for (let index = 0; index < 128; index += 1) {
      writeFileSync(filePath(String(index)), `token-${index}`)
      cache.read(String(index))
    }
    expect(cache.read('0', false)).toBe('token-0')
    writeFileSync(filePath('next'), 'token-next')
    cache.read('next')
    expect(cache.read('0', false)).toBe('token-0')
    expect(cache.read('1', false)).toBeNull()
  })

  it('bounds errors, keeps status lazy, and permits retry after keychain approval', () => {
    const cache = createCache()
    decrypt.mockImplementation(() => {
      throw new Error('Keychain access denied')
    })
    for (let index = 0; index < 132; index += 1) {
      const id = `credential-${index}`
      writeFileSync(filePath(id), Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
      expect(() => cache.read(id)).toThrow('Could not decrypt')
    }
    expect(cache.error('credential-131')).toContain('Could not decrypt')
    expect(cache.error('credential-0')).toBeUndefined()
    expect(cache.has('credential-131')).toBe(true)
    expect(decrypt).toHaveBeenCalledTimes(132)
    decrypt.mockReturnValue('approved-token')
    expect(cache.read('credential-131')).toBe('approved-token')
    expect(cache.error('credential-131')).toBeUndefined()
  })

  it('clears an old decryption error after external replacement without prompting on status', () => {
    const cache = createCache()
    writeFileSync(filePath('site'), Buffer.from([0xff, 0xfe]))
    decrypt.mockImplementation(() => {
      throw new Error('Keychain access denied')
    })
    expect(() => cache.read('site')).toThrow('Could not decrypt')
    writeFileSync(filePath('site'), 'replacement-token')
    expect(cache.has('site')).toBe(true)
    expect(cache.error('site')).toBeUndefined()
    expect(decrypt).toHaveBeenCalledOnce()
    expect(cache.read('site')).toBe('replacement-token')
  })

  it('retries after an external rotation during decryption', () => {
    const cache = createCache()
    writeFileSync(filePath('site'), 'old-token')
    decrypt.mockImplementationOnce((value) => {
      writeFileSync(filePath('site'), 'replacement-token')
      return value.toString('utf-8')
    })
    expect(cache.read('site')).toBe('old-token')
    expect(cache.read('site')).toBe('replacement-token')
    expect(cache.read('site')).toBe('replacement-token')
    expect(decrypt).toHaveBeenCalledTimes(2)
  })

  it('uses the backing path as part of a credential identity', () => {
    let path = filePath('first')
    writeFileSync(path, 'first-token')
    const cache = createIntegrationTokenFileCache({ service: 'Linear', filePath: () => path })
    expect(cache.read('workspace')).toBe('first-token')
    path = filePath('second')
    expect(cache.has('workspace')).toBe(false)
    expect(cache.read('workspace')).toBeNull()
    writeFileSync(path, 'second-token')
    expect(cache.read('workspace')).toBe('second-token')
  })

  it('forgets a locally written token so an overlapping external replacement wins', () => {
    const cache = createCache()
    writeFileSync(filePath('site'), 'old-token')
    cache.read('site')
    writeFileSync(filePath('site'), 'our-token')
    cache.forget('site')
    writeFileSync(filePath('site'), 'their-token')
    expect(cache.read('site')).toBe('their-token')
    cache.clear()
    expect(cache.read('site', false)).toBeNull()
  })
})
