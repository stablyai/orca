import type * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFile from '../../shared/secure-file'
import type * as ZcodePlanApiKeyStore from './zcode-plan-api-key-store'

const mocks = vi.hoisted(() => ({
  home: '',
  write: vi.fn<typeof fs.writeFileSync>(),
  rename: vi.fn<typeof fs.renameSync>(),
  restrict: vi.fn((_path: string, _directory: boolean) => false)
}))

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => mocks.home
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  writeFileSync: mocks.write,
  renameSync: mocks.rename
}))
vi.mock('../../shared/secure-path-windows-acl', () => ({
  restrictWindowsPathSync: mocks.restrict,
  bestEffortRestrictWindowsPath: (
    _path: string,
    _directory: boolean,
    settled: (restricted: boolean) => void
  ) => settled(false),
  resetSecureFileWindowsUserSidForTests: vi.fn()
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
  writer = await import('../../shared/secure-file')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  realFs.rmSync(mocks.home, { recursive: true, force: true })
})

function rejectReplacement(): void {
  expect(() => store.saveZcodePlanApiKey('new-key')).toThrow(
    'could not be stored securely on this device'
  )
}

describe('plaintext rollback through the secure-file writer', () => {
  it('removes only the rejected replacement when rollback fails before publication', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    mocks.write.mockImplementationOnce(realFs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('Synthetic rollback staging failure')
    })

    rejectReplacement()

    expect(mocks.write).toHaveBeenCalledTimes(2)
    expect(realFs.existsSync(keyPath)).toBe(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual([])
  })

  it.each(['restriction-false', 'restriction-throws'])(
    'keeps the previous envelope if rollback publishes before %s',
    (failure) => {
      realFs.writeFileSync(keyPath, envelope('previous-key'))
      mocks.restrict.mockImplementation((path) => {
        if (
          failure === 'restriction-throws' &&
          path === keyPath &&
          mocks.write.mock.calls.length === 2
        ) {
          throw new Error('Synthetic restored-path restriction failure')
        }
        return false
      })

      rejectReplacement()

      expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('previous-key'))
      expect(store.readZcodePlanApiKey()).toBe('previous-key')
    }
  )

  it.each([
    { phase: 'before-rollback', previous: true },
    { phase: 'before-rollback', previous: false },
    { phase: 'during-rollback', previous: true }
  ])(
    'preserves a different envelope written $phase with previous key $previous',
    ({ phase, previous }) => {
      if (previous) {
        realFs.writeFileSync(keyPath, envelope('previous-key'))
      }
      if (phase === 'before-rollback') {
        mocks.restrict.mockImplementation((path) => {
          if (path === keyPath && mocks.write.mock.calls.length === 1) {
            realFs.writeFileSync(keyPath, envelope('other-writer-key'))
          }
          return false
        })
      } else {
        mocks.write.mockImplementationOnce(realFs.writeFileSync).mockImplementationOnce(() => {
          realFs.writeFileSync(keyPath, envelope('other-writer-key'))
          throw new Error('Synthetic competing rollback writer')
        })
      }

      rejectReplacement()

      expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('other-writer-key'))
      expect(store.readZcodePlanApiKey()).toBe('other-writer-key')
    }
  )

  it('retains an identical previous plaintext envelope when retry rollback cannot publish', () => {
    realFs.writeFileSync(keyPath, envelope('new-key'))
    mocks.write.mockImplementationOnce(realFs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('Synthetic same-key rollback staging failure')
    })

    rejectReplacement()

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('new-key'))
    expect(store.readZcodePlanApiKey()).toBe('new-key')
  })

  it('removes a new unrestricted envelope without caching it when no previous key exists', () => {
    rejectReplacement()

    expect(realFs.existsSync(keyPath)).toBe(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
  })

  it('keeps the cached previous key after a rejected replacement', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    mocks.write.mockImplementationOnce(realFs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('Synthetic rollback staging failure')
    })

    rejectReplacement()

    expect(store.readZcodePlanApiKey()).toBe('previous-key')
  })
})

describe('conditional rollback publication through the real writer', () => {
  it.each([false, true])(
    'preserves a competing envelope during rollback staging with restriction %s',
    (restricted) => {
      realFs.writeFileSync(keyPath, envelope('previous-key'))
      mocks.restrict.mockImplementation((path) => {
        if (path.endsWith('.tmp') && mocks.write.mock.calls.length === 2) {
          realFs.writeFileSync(keyPath, envelope('other-writer-key'))
          return restricted
        }
        return false
      })

      rejectReplacement()

      expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('other-writer-key'))
      expect(store.readZcodePlanApiKey()).toBe('other-writer-key')
      expect(mocks.rename).toHaveBeenCalledTimes(1)
      expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
    }
  )

  it('keeps the cached previous key when a competing staged rollback cancels publication', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    mocks.restrict.mockImplementation((path) => {
      if (path.endsWith('.tmp') && mocks.write.mock.calls.length === 2) {
        realFs.writeFileSync(keyPath, envelope('other-writer-key'))
      }
      return false
    })

    rejectReplacement()

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('other-writer-key'))
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    expect(mocks.rename).toHaveBeenCalledTimes(1)
  })

  it('preserves an unowned envelope if rollback staging restriction throws', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    mocks.restrict.mockImplementation((path) => {
      if (path.endsWith('.tmp') && mocks.write.mock.calls.length === 2) {
        realFs.writeFileSync(keyPath, envelope('other-writer-key'))
        throw new Error('Synthetic staged restriction failure')
      }
      return false
    })

    rejectReplacement()

    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('other-writer-key'))
    expect(store.readZcodePlanApiKey()).toBe('other-writer-key')
    expect(mocks.rename).toHaveBeenCalledTimes(1)
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })

  it('removes only the owned rejected plaintext when rollback rename fails', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    mocks.rename.mockImplementationOnce(realFs.renameSync).mockImplementationOnce(() => {
      throw new Error('Synthetic rollback rename failure')
    })

    rejectReplacement()

    expect(realFs.existsSync(keyPath)).toBe(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual([])
  })

  it.each([false, true])(
    'cancels guarded durable publication without changing a previously present target: %s',
    (previous) => {
      if (previous) {
        realFs.writeFileSync(keyPath, envelope('previous-key'))
      }
      const shouldPublish = vi.fn(() => false)

      expect(
        writer.writeSecureFile(keyPath, envelope('candidate-key'), {
          durable: true,
          shouldPublish
        })
      ).toBe(false)

      expect(shouldPublish).toHaveBeenCalledTimes(1)
      expect(mocks.rename).not.toHaveBeenCalled()
      expect(realFs.existsSync(keyPath)).toBe(previous)
      expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(
        previous ? ['zcode-plan-api-key.enc'] : []
      )
      if (previous) {
        expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('previous-key'))
      }
    }
  )

  it('cleans staged bytes when the publication predicate throws', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))

    expect(() =>
      writer.writeSecureFile(keyPath, envelope('candidate-key'), {
        shouldPublish: () => {
          throw new Error('Synthetic ownership read failure')
        }
      })
    ).toThrow('Synthetic ownership read failure')

    expect(mocks.rename).not.toHaveBeenCalled()
    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('previous-key'))
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })

  it('retains best-effort restriction outcomes when guarded publication is allowed', () => {
    realFs.writeFileSync(keyPath, envelope('previous-key'))
    const shouldPublish = vi.fn(() => true)

    expect(
      writer.writeSecureFile(keyPath, envelope('candidate-key'), {
        durable: true,
        shouldPublish
      })
    ).toBe(false)

    expect(shouldPublish).toHaveBeenCalledTimes(1)
    expect(mocks.rename).toHaveBeenCalledTimes(1)
    expect(realFs.readFileSync(keyPath, 'utf8')).toBe(envelope('candidate-key'))
    expect(realFs.readdirSync(join(mocks.home, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })

  it('checks publication immediately after staged hardening and before rename', () => {
    const operations: string[] = []
    mocks.restrict.mockImplementation((path) => {
      operations.push(path.endsWith('.tmp') ? 'staged restriction' : 'published restriction')
      return true
    })
    mocks.rename.mockImplementation((from, to) => {
      operations.push('rename')
      realFs.renameSync(from, to)
    })

    expect(
      writer.writeSecureFile(keyPath, envelope('candidate-key'), {
        shouldPublish: () => {
          operations.push('ownership check')
          return true
        }
      })
    ).toBe(true)

    expect(operations).toEqual([
      'staged restriction',
      'ownership check',
      'rename',
      'published restriction'
    ])
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
