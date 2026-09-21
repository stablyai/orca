import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

const files = vi.hoisted(() => ({ map: new Map<string, string>() }))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.map.has(path),
  readFileSync: (path: string) => {
    const content = files.map.get(path)
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }
    return content
  },
  rmSync: (path: string) => files.map.delete(path)
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

// Why: writeSecureFile writes into ~/.orca; stub it to an in-memory map via the store mock layer.
const written = vi.hoisted(() => ({ content: null as string | null }))

vi.mock('../../shared/secure-file', () => ({
  writeSecureFile: (path: string, content: string) => {
    written.content = content
    files.map.set(path, content)
  },
  hardenExistingSecureFile: () => {}
}))

import { readFactoryApiKey, saveFactoryApiKey, clearFactoryApiKey } from './factory-api-key-store'

beforeEach(() => {
  written.content = null
  files.map.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('factory-api-key-store', () => {
  it('reads null when no key was saved', () => {
    expect(readFactoryApiKey()).toBeNull()
  })

  it('save rejects an empty key', () => {
    expect(() => saveFactoryApiKey('   ')).toThrow('Factory API key is required')
  })

  it('save writes an encrypted envelope and reads the trimmed key back', () => {
    saveFactoryApiKey('  fk-test-key  ')
    expect(written.content).toContain('orca-factory-key:v1:')
    expect(written.content).toContain('encrypted')
    expect(readFactoryApiKey()).toBe('fk-test-key')
  })

  it('clear removes the stored key', () => {
    saveFactoryApiKey('fk-test-key')
    clearFactoryApiKey()
    expect(readFactoryApiKey()).toBeNull()
  })
})
