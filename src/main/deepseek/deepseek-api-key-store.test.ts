import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'

const encryptionAvailable = { value: true }

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable.value,
    // Reversible stand-in for OS encryption so the envelope round-trips in tests.
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, '')
  }
}))

let home: string

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof NodeOs
  return { ...actual, homedir: () => home }
})

import {
  clearDeepSeekApiKey,
  hasDeepSeekApiKey,
  readStoredDeepSeekApiKey,
  resetDeepSeekApiKeyCacheForTests,
  saveDeepSeekApiKey
} from './deepseek-api-key-store'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'deepseek-key-'))
  encryptionAvailable.value = true
  resetDeepSeekApiKeyCacheForTests()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('deepseek-api-key-store', () => {
  it('reports not configured before a key is saved', () => {
    expect(hasDeepSeekApiKey()).toBe(false)
    expect(readStoredDeepSeekApiKey()).toBeNull()
  })

  it('saves and reads back an encrypted key', () => {
    saveDeepSeekApiKey('  sk-abc123  ')
    expect(hasDeepSeekApiKey()).toBe(true)
    resetDeepSeekApiKeyCacheForTests()
    expect(readStoredDeepSeekApiKey()).toBe('sk-abc123')
  })

  it('rejects an empty key', () => {
    expect(() => saveDeepSeekApiKey('   ')).toThrow('required')
  })

  it('clears a stored key', () => {
    saveDeepSeekApiKey('sk-abc123')
    clearDeepSeekApiKey()
    expect(hasDeepSeekApiKey()).toBe(false)
    expect(readStoredDeepSeekApiKey()).toBeNull()
  })

  it('falls back to plaintext when encryption is unavailable and still round-trips', () => {
    encryptionAvailable.value = false
    saveDeepSeekApiKey('sk-plain')
    expect(existsSync(join(home, '.orca', 'deepseek-api-key.enc'))).toBe(true)
    resetDeepSeekApiKeyCacheForTests()
    expect(readStoredDeepSeekApiKey()).toBe('sk-plain')
  })
})
