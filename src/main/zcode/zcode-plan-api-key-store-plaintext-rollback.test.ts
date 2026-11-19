import type * as fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import type * as SecureFile from '../../shared/secure-storage/secure-file'
import type * as ZcodePlanApiKeyStore from './zcode-plan-api-key-store'

const mocks = vi.hoisted(() => ({
  home: '',
  write: vi.fn<typeof fs.writeFileSync>(),
  rename: vi.fn<typeof fs.renameSync>(),
  restrict: vi.fn((_path: string, _directory: boolean) => false)
}))

beforeEach(() =>
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('unavailable')
    },
    decryptString: () => {
      throw new Error('unavailable')
    },
    describeProtectionGap: () => 'unavailable'
  })
)
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  rename: (...args: Parameters<typeof fs.renameSync>) => mocks.rename(...args)
}))
vi.mock('../../shared/secure-storage/windows-credential-file-io', () => ({
  createWindowsCredentialStage: async (path: string, data: string | Buffer) => {
    mocks.write(path, data)
    return mocks.restrict(path, false)
  },
  hardenWindowsCredentialPath: async () => false
}))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => mocks.home
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  writeFileSync: mocks.write,
  renameSync: mocks.rename
}))
// Stage through mocked writeFile and inject restriction outcome like the born-restricted creator.
vi.mock('../../shared/secure-storage/secure-path-windows-acl', () => ({
  restrictWindowsPathSync: mocks.restrict,
  writeRestrictedWindowsFile: (path: string, contents: string) => {
    mocks.write(path, contents, { encoding: 'utf-8', mode: 0o600 })
    return mocks.restrict(path, false)
  },
  restrictWindowsDirectory: () => Promise.resolve(false)
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const realFs = await vi.importActual<typeof fs>('node:fs')
const envelope = (value: string): string =>
  `orca-zcode-plan-api-key:v1:plaintext:${Buffer.from(value).toString('base64')}`
let store: typeof ZcodePlanApiKeyStore
let writer: typeof SecureFile
let keyPath: string

beforeEach(async () => {
  mocks.home = realFs.mkdtempSync(join(os.tmpdir(), 'orca-glm-plaintext-rollback-'))
  keyPath = join(mocks.home, '.orca', 'zcode-plan-api-key.enc')
  realFs.mkdirSync(join(mocks.home, '.orca'))
  mocks.write.mockReset().mockImplementation(realFs.writeFileSync)
  mocks.rename.mockReset().mockImplementation(realFs.renameSync)
  mocks.restrict.mockReset().mockReturnValue(false)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.resetModules()
  store = await import('./zcode-plan-api-key-store')
  writer = await import('../../shared/secure-storage/secure-file')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  realFs.rmSync(mocks.home, { recursive: true, force: true })
})

async function rejectReplacement(): Promise<void> {
  await expect(store.saveZcodePlanApiKey('new-key')).rejects.toThrow(
    'could not be stored securely on this device'
  )
}

describe('plaintext rollback through the secure-file writer', () => {
  // Rename preserves staged DACL; later read-time hardening failure must not erase the restored key.
  it('keeps the previous envelope if rollback publishes before restriction fails', async () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))

    await rejectReplacement()

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('previous-key'))
    expect(await store.readZcodePlanApiKey()).toBe('previous-key')
  })

  it('retains an identical previous plaintext envelope when retry rollback cannot publish', async () => {
    realFs.writeFileSync(keyPath, envelope('new-key'))
    mocks.write.mockImplementationOnce(realFs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('Synthetic same-key rollback staging failure')
    })

    await rejectReplacement()

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('new-key'))
    expect(await store.readZcodePlanApiKey()).toBe('new-key')
  })

  it('removes a new unrestricted envelope without caching it when no previous key exists', async () => {
    await rejectReplacement()

    expect(realFs.existsSync(keyPath)).toBe(false)
    expect(await store.readZcodePlanApiKey()).toBeNull()
  })

  it('keeps the cached previous key after a rejected replacement', async () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    expect(await store.readZcodePlanApiKey()).toBe('previous-key')
    mocks.write.mockImplementationOnce(realFs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('Synthetic rollback staging failure')
    })

    await rejectReplacement()

    expect(await store.readZcodePlanApiKey()).toBe('previous-key')
  })
})

describe('conditional rollback publication through the real writer', () => {
  it('removes only the owned rejected plaintext when rollback rename fails', async () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    mocks.rename.mockImplementationOnce(realFs.renameSync).mockImplementationOnce(() => {
      throw new Error('Synthetic rollback rename failure')
    })

    await rejectReplacement()

    expect(realFs.existsSync(keyPath)).toBe(false)
    expect(await store.readZcodePlanApiKey()).toBeNull()
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual([])
  })

  it('cleans staged bytes when the publication predicate throws', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))

    expect(() =>
      writer.writeSecureFile(keyPath, envelope('candidate-key'), {
        shouldPublish: () => {
          throw new Error('Synthetic ownership read failure')
        }
      })
    ).toThrow('Synthetic ownership read failure')

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('previous-key'))
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })

  it('cleans guarded staging bytes if rename throws without deleting the original target', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    mocks.rename.mockImplementation(() => {
      throw new Error('Synthetic guarded rename failure')
    })

    expect(() =>
      writer.writeSecureFile(keyPath, envelope('candidate-key'), {
        shouldPublish: () => true
      })
    ).toThrow('Synthetic guarded rename failure')

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('previous-key'))
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })
})
