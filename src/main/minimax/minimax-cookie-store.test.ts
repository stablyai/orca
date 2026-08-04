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

const readFileMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')
const writeSecureFileMock = vi.fn()
const rmSyncMock = vi.fn()

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('node:fs', () => ({
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca/minimax-session-cookie.enc'
const envelope = (kind: 'encrypted' | 'plaintext', value: string): string =>
  `orca-minimax-cookie:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof MiniMaxCookieStore> {
  return await import('./minimax-cookie-store')
}

describe('minimax-cookie-store', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    rmSyncMock.mockReset()
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

  it('publishes a fresh missing snapshot when no file exists yet', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.hasMiniMaxSessionCookie()).toBe(false)
    expect(store.getMiniMaxCredentialSnapshot()).toMatchObject({
      value: null,
      stale: false,
      availability: 'missing'
    })
  })

  it('keeps read-time hardening out of the main-process hydration path', async () => {
    readFileMock.mockResolvedValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.hasMiniMaxSessionCookie()).toBe(true)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
  })

  it('writes the cookie using safeStorage when encryption is available', async () => {
    const store = await loadStore()
    await store.saveMiniMaxSessionCookie('_token=abc; minimax_group_id_v2=42')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('_token=abc; minimax_group_id_v2=42')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '_token=abc; minimax_group_id_v2=42')
    )
    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(1)
  })

  it('warns and writes plaintext when safeStorage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStore()
    await store.saveMiniMaxSessionCookie('_token=abc')
    expect(writeSecureFileMock).toHaveBeenCalledWith(storePath, envelope('plaintext', '_token=abc'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('safeStorage encryption unavailable'))
    warn.mockRestore()
  })

  it('refuses empty cookies', async () => {
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('   ')).toThrow(/required/)
  })

  it('hydrates a decrypted cookie and serves later reads from memory', async () => {
    readFileMock.mockResolvedValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValue('_token=cached; minimax_group_id_v2=9')
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    const first = store.readMiniMaxSessionCookie()
    const second = store.readMiniMaxSessionCookie()
    expect(first).toBe('_token=cached; minimax_group_id_v2=9')
    expect(second).toBe(first)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted-payload'))
  })

  it('returns null before hydration', async () => {
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })

  it('returns enveloped plaintext when safeStorage is unavailable and reads succeed', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    readFileMock.mockResolvedValue(Buffer.from(envelope('plaintext', '_token=plaintext')))
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=plaintext')
  })

  it('reads legacy plaintext cookies when decrypting is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    readFileMock.mockResolvedValue(Buffer.from('_token=legacy'))
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy')
  })

  it('reads legacy plaintext cookies when decrypting fails', async () => {
    readFileMock.mockResolvedValue(Buffer.from('_token=legacy'))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy')
  })

  it('marks encrypted legacy bytes unavailable when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    readFileMock.mockResolvedValue(Buffer.from('encrypted-payload'))
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.getMiniMaxCredentialSnapshot()).toMatchObject({
      value: null,
      stale: true,
      availability: 'unavailable'
    })
  })

  it('marks encrypted envelopes unavailable when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    readFileMock.mockResolvedValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.getMiniMaxCredentialSnapshot().availability).toBe('unavailable')
  })

  it('marks the snapshot unavailable when decryption fails', async () => {
    readFileMock.mockResolvedValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.getMiniMaxCredentialSnapshot().availability).toBe('unavailable')
  })

  it('clears the cached cookie and removes the file', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValueOnce('_token=preclear')
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=preclear')
    await store.clearMiniMaxSessionCookie()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })

  it('does not decrypt or publish a read that completes after clear', async () => {
    let resolveRead!: (value: Buffer) => void
    readFileMock.mockReturnValue(
      new Promise<Buffer>((resolve) => {
        resolveRead = resolve
      })
    )
    const store = await loadStore()
    const hydration = store.hydrateMiniMaxSessionCookie()

    await store.clearMiniMaxSessionCookie()
    resolveRead(Buffer.from(envelope('encrypted', 'revoked-payload')))
    await hydration

    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    expect(store.readMiniMaxSessionCookie()).toBeNull()
    expect(store.getMiniMaxCredentialSnapshot()).toMatchObject({
      value: null,
      stale: false,
      availability: 'missing'
    })
  })

  it('does not publish a save whose write failed', async () => {
    writeSecureFileMock.mockImplementationOnce(() => {
      throw new Error('contended')
    })
    const store = await loadStore()

    expect(() => store.saveMiniMaxSessionCookie('_token=blocked')).toThrow('contended')

    expect(store.getMiniMaxCredentialSnapshot()).toMatchObject({
      value: null,
      stale: true,
      availability: 'unavailable'
    })
  })

  it('keeps the cached cookie when file removal fails', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValueOnce('_token=preclear')
    const store = await loadStore()
    await store.hydrateMiniMaxSessionCookie()
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error('contended')
    })

    expect(() => store.clearMiniMaxSessionCookie()).toThrow('contended')

    expect(rmSyncMock).toHaveBeenCalledTimes(1)
    expect(store.readMiniMaxSessionCookie()).toBe('_token=preclear')
    expect(store.getMiniMaxCredentialSnapshot().availability).toBe('ready')
  })
})
