import { existsSync, mkdtempSync, statSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''
const decryptStringMock = vi.fn((value: Buffer) => value.toString('utf-8'))

async function loadStore(
  options: {
    unlinkError?: NodeJS.ErrnoException
    writeError?: Error
    decryptError?: Error
  } = {}
) {
  vi.resetModules()
  vi.doUnmock('node:fs')
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString:
      options.decryptError !== undefined
        ? () => {
            throw options.decryptError
          }
        : decryptStringMock,
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  if (options.writeError) {
    const error = options.writeError
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs')
      return {
        ...actual,
        writeSync: () => {
          throw error
        }
      }
    })
  }
  if (options.unlinkError) {
    const error = options.unlinkError
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs')
      return {
        ...actual,
        unlinkSync: () => {
          throw error
        }
      }
    })
  }
  return import('./credential-store')
}

function saveInput() {
  return {
    token: 'secret-token',
    viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
  }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-kanban-store-'))
  decryptStringMock.mockClear()
})

describe('Kanban credential store', () => {
  it('persists an encrypted secret and plaintext viewer metadata, then reads them back', async () => {
    const store = await loadStore()
    store.saveKanbanCredential(saveInput())

    expect(store.hasStoredKanbanCredential()).toBe(true)
    expect(store.getStoredKanbanMetadata()).toMatchObject({
      version: 1,
      viewerId: 'user-1',
      viewerName: 'Ada',
      viewerLevel: 'admin'
    })
    expect(store.loadStoredKanbanToken({ force: true })).toBe('secret-token')
  })

  it.skipIf(process.platform === 'win32')('writes both credential files 0600', async () => {
    const store = await loadStore()
    store.saveKanbanCredential(saveInput())

    for (const file of ['kanban-credential.enc', 'kanban-credential.json']) {
      expect(statSync(join(tempHome, '.orca', file)).mode & 0o777).toBe(0o600)
    }
  })

  it.skipIf(process.platform === 'win32')(
    're-tightens permissions when overwriting an existing credential',
    async () => {
      const store = await loadStore()
      store.saveKanbanCredential(saveInput())
      const { chmodSync } = await import('node:fs')
      for (const file of ['kanban-credential.enc', 'kanban-credential.json']) {
        chmodSync(join(tempHome, '.orca', file), 0o644)
      }
      store.saveKanbanCredential(saveInput())

      for (const file of ['kanban-credential.enc', 'kanban-credential.json']) {
        expect(statSync(join(tempHome, '.orca', file)).mode & 0o777).toBe(0o600)
      }
    }
  )

  it('does not decrypt for metadata/status reads — only on a forced token load', async () => {
    const store = await loadStore()
    store.saveKanbanCredential(saveInput())

    store._resetKanbanCredentialCache()

    expect(store.getStoredKanbanMetadata()?.viewerId).toBe('user-1')
    expect(store.hasStoredKanbanCredential()).toBe(true)
    expect(decryptStringMock).not.toHaveBeenCalled()

    expect(store.loadStoredKanbanToken()).toBeNull()
    expect(decryptStringMock).not.toHaveBeenCalled()

    expect(store.loadStoredKanbanToken({ force: true })).toBe('secret-token')
    expect(decryptStringMock).toHaveBeenCalledTimes(1)
    expect(store.loadStoredKanbanToken()).toBe('secret-token')
    expect(decryptStringMock).toHaveBeenCalledTimes(1)
  })

  it('rejects non-string fields from hand-edited metadata', async () => {
    const store = await loadStore()
    store.saveKanbanCredential(saveInput())
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tempHome, '.orca', 'kanban-credential.json'),
      JSON.stringify({
        version: 1,
        viewerId: { evil: true },
        viewerName: 42,
        viewerLevel: null,
        updatedAt: ''
      })
    )
    store._resetKanbanCredentialCache()

    expect(store.getStoredKanbanMetadata()).toMatchObject({
      viewerId: '',
      viewerName: '',
      viewerLevel: '',
      updatedAt: ''
    })
  })

  it('keeps the previous credential intact when the secret write fails', async () => {
    const store = await loadStore()
    store.saveKanbanCredential(saveInput())
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(join(tempHome, '.orca', 'kanban-credential.enc'))

    const failing = await loadStore({ writeError: new Error('disk full') })
    expect(() =>
      failing.saveKanbanCredential({
        token: 'second-token',
        viewer: { id: 'user-2', name: 'Grace', level: 'member' }
      })
    ).toThrow(/disk full/)

    expect(readFileSync(join(tempHome, '.orca', 'kanban-credential.enc'))).toEqual(before)
    expect(existsSync(join(tempHome, '.orca', 'kanban-credential.enc.tmp'))).toBe(false)
  })

  it('reports a decrypt failure without exposing ciphertext or the token', async () => {
    const denied = new Error('userCanceledErr')
    const store = await loadStore({ decryptError: denied })
    store.saveKanbanCredential(saveInput())
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tempHome, '.orca', 'kanban-credential.enc'),
      Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe])
    )
    store._resetKanbanCredentialCache()

    let caught: unknown
    try {
      store.loadStoredKanbanToken({ force: true })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('Could not decrypt saved Kanban credential')
    expect(message).not.toContain('secret-token')
    expect(message).not.toContain('\u00ff')
    expect(store.getStoredKanbanCredentialError()).toBe(message)
  })

  it('clears both files and in-memory state on disconnect', async () => {
    const store = await loadStore()
    store.saveKanbanCredential(saveInput())

    store.clearStoredKanbanCredential()

    expect(store.hasStoredKanbanCredential()).toBe(false)
    expect(store.getStoredKanbanMetadata()).toBeNull()
    expect(store.loadStoredKanbanToken()).toBeNull()
    expect(existsSync(join(tempHome, '.orca', 'kanban-credential.enc'))).toBe(false)
    expect(existsSync(join(tempHome, '.orca', 'kanban-credential.json'))).toBe(false)
  })

  it('surfaces a non-ENOENT delete failure instead of silently keeping the files', async () => {
    const denied: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), {
      code: 'EACCES'
    })
    const store = await loadStore({ unlinkError: denied })
    store.saveKanbanCredential(saveInput())

    expect(() => store.clearStoredKanbanCredential()).toThrow(/permission denied/)
    expect(existsSync(join(tempHome, '.orca', 'kanban-credential.enc'))).toBe(true)
  })

  it('ignores a missing file on disconnect', async () => {
    const missing: NodeJS.ErrnoException = Object.assign(new Error('no such file'), {
      code: 'ENOENT'
    })
    const store = await loadStore({ unlinkError: missing })
    expect(() => store.clearStoredKanbanCredential()).not.toThrow()
  })
})
