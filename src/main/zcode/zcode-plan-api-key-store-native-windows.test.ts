import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secret-store'
import type * as WindowsAcl from '../../shared/secure-path-windows-acl'
import type * as Store from './zcode-plan-api-key-store'

type NativeCase = {
  home: string
  fault: 'none' | 'before-restore' | 'after-restore' | 'competing'
  reject: boolean
  writes: number
  renames: number
  stages: number
  nativeOutcomes: boolean[]
  directories: boolean[]
}
const state = vi.hoisted((): NativeCase => ({
  home: '',
  fault: 'none',
  reject: false,
  writes: 0,
  renames: 0,
  stages: 0,
  nativeOutcomes: [],
  directories: []
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
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => state.home
}))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return {
    ...real,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      real.renameSync(...args)
      if (++state.renames === 2 && state.fault === 'after-restore') {
        throw new Error('Synthetic failure after restore publication')
      }
    }
  }
})
// The real born-restricted create, with faults injected around it.
vi.mock('../../shared/secure-path-windows-acl', async (original) => {
  const real = await original<typeof WindowsAcl>()
  const files = await vi.importActual<typeof fs>('node:fs')
  return {
    ...real,
    writeRestrictedWindowsFile: (path: string, contents: string) => {
      if (++state.writes === 2 && state.fault === 'before-restore') {
        throw new Error('Synthetic restore staging failure')
      }
      const outcome = real.writeRestrictedWindowsFile(path, contents)
      state.nativeOutcomes.push(outcome)
      if (state.fault === 'competing' && ++state.stages === 2) {
        const competing = join(state.home, '.orca', 'competing-key')
        expect(real.writeRestrictedWindowsFile(competing, envelope('synthetic-competing'))).toBe(
          true
        )
        files.renameSync(competing, join(state.home, '.orca', 'zcode-plan-api-key.enc'))
      }
      return state.reject ? false : outcome
    },
    restrictWindowsDirectory: (path: string) =>
      real.restrictWindowsDirectory(path).then((restricted) => {
        state.directories.push(restricted)
        return restricted
      })
  }
})

const envelope = (key: string) =>
  `orca-zcode-plan-api-key:v1:plaintext:${Buffer.from(key).toString('base64')}`
let store: typeof Store
let keyPath: string

describe.skipIf(process.platform !== 'win32')('native Windows Coding Plan rollback', () => {
  beforeEach(async () => {
    state.home = fs.mkdtempSync(join(os.tmpdir(), 'orca-native-plan-'))
    state.fault = 'none'
    state.reject = false
    state.writes = 0
    state.renames = 0
    state.stages = 0
    state.nativeOutcomes = []
    state.directories = []
    keyPath = join(state.home, '.orca', 'zcode-plan-api-key.enc')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.resetModules()
    store = await import('./zcode-plan-api-key-store')
    store.saveZcodePlanApiKey('synthetic-previous')
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(envelope('synthetic-previous'))
    expect(state.nativeOutcomes.length).toBeGreaterThan(0)
    expect(state.nativeOutcomes.every(Boolean)).toBe(true)
    await vi.waitFor(
      () => {
        expect(state.directories.length).toBeGreaterThan(0)
        expect(state.directories.every(Boolean)).toBe(true)
      },
      { timeout: 15_000 }
    )
    state.writes = 0
    state.renames = 0
    state.stages = 0
    state.reject = true
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(state.home, { recursive: true, force: true })
  })

  it.each(['before-restore', 'after-restore', 'competing'] as const)(
    'preserves the file contract after %s with real file and directory ACLs',
    (fault) => {
      state.fault = fault
      expect(() => store.saveZcodePlanApiKey('synthetic-rejected')).toThrow(
        'could not be stored securely'
      )
      if (fault === 'before-restore') {
        expect(fs.existsSync(keyPath)).toBe(false)
      } else {
        expect(fs.readFileSync(keyPath, 'utf8')).toBe(
          envelope(fault === 'competing' ? 'synthetic-competing' : 'synthetic-previous')
        )
      }
      expect(fs.readdirSync(join(state.home, '.orca')).some((name) => name.endsWith('.tmp'))).toBe(
        false
      )
      expect(state.nativeOutcomes.every(Boolean)).toBe(true)
    },
    30_000
  )
})
