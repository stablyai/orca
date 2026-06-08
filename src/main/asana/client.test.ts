import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''

type SafeStorageStub = {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

const plaintextSafeStorage: SafeStorageStub = {
  isEncryptionAvailable: () => false,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString('utf-8')
}

// Marker-prefixed transform proves the encrypt/decrypt branch actually ran rather
// than silently falling through to the plaintext path.
const encryptedSafeStorage: SafeStorageStub = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`enc:${value}`),
  decryptString: (value: Buffer) => value.toString('utf-8').replace(/^enc:/, '')
}

async function loadClientModule(safeStorage: SafeStorageStub = plaintextSafeStorage) {
  vi.resetModules()
  vi.doMock('electron', () => ({ safeStorage }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./client')
}

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: 'OK',
    json: async () => body
  }) as unknown as typeof fetch
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-asana-client-'))
  vi.restoreAllMocks()
})

describe('Asana client workspace storage', () => {
  it('stores every workspace a token grants and selects the first', async () => {
    const asana = await loadClientModule()
    mockFetchOnce({
      data: {
        gid: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        workspaces: [
          { gid: 'ws-1', name: 'Alpha' },
          { gid: 'ws-2', name: 'Beta' }
        ]
      }
    })

    await expect(asana.connect({ apiToken: 'pat-1' })).resolves.toMatchObject({
      ok: true,
      viewer: { gid: 'user-1', name: 'Ada' }
    })

    expect(asana.getStatus()).toMatchObject({
      connected: true,
      activeWorkspaceId: 'ws-1',
      selectedWorkspaceId: 'ws-1',
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' }
      ]
    })

    expect(asana.selectWorkspace('all')).toMatchObject({ selectedWorkspaceId: 'all' })

    asana.disconnect('ws-1')
    expect(asana.getStatus()).toMatchObject({
      connected: true,
      workspaces: [{ id: 'ws-2', name: 'Beta' }]
    })
  })

  it('rejects a token that has no accessible workspaces', async () => {
    const asana = await loadClientModule()
    mockFetchOnce({ data: { gid: 'user-1', name: 'Ada', workspaces: [] } })

    await expect(asana.connect({ apiToken: 'pat-1' })).resolves.toMatchObject({ ok: false })
    expect(asana.getStatus().connected).toBe(false)
  })

  it('builds a bearer-authenticated client for the selected workspace', async () => {
    const asana = await loadClientModule()
    mockFetchOnce({
      data: { gid: 'user-1', name: 'Ada', workspaces: [{ gid: 'ws-1', name: 'Alpha' }] }
    })
    await asana.connect({ apiToken: 'pat-1' })

    const clients = asana.getClients('ws-1')
    expect(clients).toHaveLength(1)
    expect(clients[0].authorization).toBe('Bearer pat-1')
    expect(clients[0].workspace.id).toBe('ws-1')
  })

  it('encrypts the token at rest and decrypts it on a fresh load', async () => {
    const writer = await loadClientModule(encryptedSafeStorage)
    mockFetchOnce({
      data: { gid: 'user-1', name: 'Ada', workspaces: [{ gid: 'ws-1', name: 'Alpha' }] }
    })
    await writer.connect({ apiToken: 'pat-1' })

    // Fresh module instance: in-memory token cache is empty, so this exercises the
    // real on-disk encrypted round-trip (decryptString) rather than the cache hit.
    const reader = await loadClientModule(encryptedSafeStorage)
    const clients = reader.getClients('ws-1')
    expect(clients).toHaveLength(1)
    expect(clients[0].authorization).toBe('Bearer pat-1')
  })

  it('treats a token that cannot be decrypted as having no usable client', async () => {
    const writer = await loadClientModule(encryptedSafeStorage)
    mockFetchOnce({
      data: { gid: 'user-1', name: 'Ada', workspaces: [{ gid: 'ws-1', name: 'Alpha' }] }
    })
    await writer.connect({ apiToken: 'pat-1' })

    // A foreign-key-encrypted or corrupted token file: decryptString throws.
    const reader = await loadClientModule({
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: () => {
        throw new Error('decryption failed')
      }
    })
    // readToken swallows the failure and yields null, so no client is built.
    expect(reader.getClients('ws-1')).toEqual([])
    // The file still exists, so status reports connected — only usability degrades.
    expect(reader.getStatus().connected).toBe(true)
  })
})
