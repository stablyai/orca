import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MiniMaxCookieStore from './minimax-cookie-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const electronMock = vi.hoisted(() => ({
  safeStorage: safeStorageMock
}))

vi.mock('electron', () => electronMock)

const existsSyncMock = vi.fn()
const mkdirSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const writeFileSyncMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

const storePath = '/home/test/.orca/minimax-session-cookie.enc'

async function loadStore(): Promise<typeof MiniMaxCookieStore> {
  return await import('./minimax-cookie-store')
}

describe('minimax-cookie-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('returns false when no file exists yet', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.hasMiniMaxSessionCookie()).toBe(false)
  })

  it('writes the cookie using safeStorage when encryption is available', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxSessionCookie('_token=abc; minimax_group_id_v2=42')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('_token=abc; minimax_group_id_v2=42')
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      storePath,
      Buffer.from('_token=abc; minimax_group_id_v2=42'),
      { mode: 0o600 }
    )
    expect(mkdirSyncMock).toHaveBeenCalledWith('/home/test/.orca', { recursive: true })
  })

  it('warns and writes plaintext when safeStorage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxSessionCookie('_token=abc')
    expect(writeFileSyncMock).toHaveBeenCalledWith(storePath, '_token=abc', {
      encoding: 'utf8',
      mode: 0o600
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('safeStorage encryption unavailable'))
    warn.mockRestore()
  })

  it('refuses empty cookies', async () => {
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('   ')).toThrow(/required/)
  })

  it('reads decrypted cookie from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('encrypted-payload'))
    safeStorageMock.decryptString.mockReturnValue('_token=cached; minimax_group_id_v2=9')
    const store = await loadStore()
    const first = store.readMiniMaxSessionCookie()
    const second = store.readMiniMaxSessionCookie()
    expect(first).toBe('_token=cached; minimax_group_id_v2=9')
    expect(second).toBe(first)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
  })

  it('returns null when no file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })

  it('returns plaintext when safeStorage is unavailable and reads succeed', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('_token=plaintext'))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=plaintext')
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('encrypted-payload'))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('clears the cached cookie and removes the file', async () => {
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(Buffer.from('encrypted-payload'))
    safeStorageMock.decryptString.mockReturnValueOnce('_token=preclear')
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=preclear')
    store.clearMiniMaxSessionCookie()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })
})
