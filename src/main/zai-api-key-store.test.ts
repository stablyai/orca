import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  isEncryptionAvailable: vi.fn(() => true)
}))

let tempHome = ''

async function loadStoreModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({ safeStorage: safeStorageMock }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./zai-api-key-store')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-zai-api-key-'))
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReset()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

describe('Z.AI API key store', () => {
  it('saves, reads, and clears an encrypted key with an explicit storage mode', async () => {
    const store = await loadStoreModule()

    store.saveZaiApiKey(' sk-test ')

    expect(store.hasZaiApiKey()).toBe(true)
    expect(store.readZaiApiKey()).toBe('sk-test')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('sk-test')

    const keyPath = join(tempHome, '.orca', 'zai-api-key.enc')
    expect(JSON.parse(readFileSync(keyPath, 'utf8'))).toEqual({
      v: 1,
      mode: 'encrypted',
      payload: Buffer.from('sk-test').toString('base64')
    })

    store.clearZaiApiKey()

    expect(store.hasZaiApiKey()).toBe(false)
    expect(store.readZaiApiKey()).toBeNull()
  })

  it('falls back to plaintext storage when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStoreModule()

    store.saveZaiApiKey('sk-plaintext')

    const keyPath = join(tempHome, '.orca', 'zai-api-key.enc')
    expect(JSON.parse(readFileSync(keyPath, 'utf8'))).toEqual({
      v: 1,
      mode: 'plaintext',
      payload: 'sk-plaintext'
    })
    expect(store.readZaiApiKey()).toBe('sk-plaintext')
    expect(warn).toHaveBeenCalledWith(
      '[zai-api-key] safeStorage encryption unavailable — storing Z.AI API key in plaintext'
    )

    warn.mockRestore()
  })

  it('keeps plaintext keys readable when encryption becomes available later', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStoreModule()

    store.saveZaiApiKey('sk-plaintext')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)

    expect(store.readZaiApiKey()).toBe('sk-plaintext')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('reports missing configuration without creating storage files', async () => {
    const store = await loadStoreModule()

    expect(store.hasZaiApiKey()).toBe(false)
    expect(store.readZaiApiKey()).toBeNull()
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
  })
})
