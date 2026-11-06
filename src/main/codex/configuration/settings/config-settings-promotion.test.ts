import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as CodexFsUtils from '../../../codex-accounts/fs-utils'

// Bypass platform-specific socket paths so asserted config bytes stay host-independent.
vi.mock('../shared-server/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

const { homedirMock, promotionTestState } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  promotionTestState: { failAtomicWrite: false, atomicWritePaths: [] as string[] }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

vi.mock('../../../codex-accounts/fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexFsUtils>()
  return {
    ...actual,
    writeFileAtomically: (...args: Parameters<typeof actual.writeFileAtomically>) => {
      promotionTestState.atomicWritePaths.push(args[0])
      if (promotionTestState.failAtomicWrite) {
        throw new Error('injected atomic write failure')
      }
      return actual.writeFileAtomically(...args)
    }
  }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-settings-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-settings-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  promotionTestState.failAtomicWrite = false
  promotionTestState.atomicWritePaths.length = 0
  if (homedir() !== tmpHome) {
    throw new Error('node:os homedir mock is not active; refusing to touch the real ~/.codex')
  }
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

function systemConfigPath(): string {
  return join(tmpHome, '.codex', 'config.toml')
}

function runtimeHomeDir(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function runtimeConfigPath(): string {
  return join(runtimeHomeDir(), 'config.toml')
}

function baselinePath(): string {
  return join(runtimeHomeDir(), '.orca-config-settings-baseline.json')
}

function writeSystemConfig(content: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

function readSystemConfig(): string {
  return readFileSync(systemConfigPath(), 'utf-8')
}

function readRuntimeConfig(): string {
  return readFileSync(runtimeConfigPath(), 'utf-8')
}

function simulateCodexSettingWrite(key: string, rawValue: string): void {
  mkdirSync(runtimeHomeDir(), { recursive: true })
  const existing = existsSync(runtimeConfigPath()) ? readFileSync(runtimeConfigPath(), 'utf-8') : ''
  const linePattern = new RegExp(`^${key}[ \\t]*=.*$`, 'm')
  const rendered = `${key} = ${rawValue}`
  const next = linePattern.test(existing)
    ? existing.replace(linePattern, rendered)
    : `${rendered}\n${existing}`
  writeFileSync(runtimeConfigPath(), next, 'utf-8')
}

describe('codex settings write-back promotion', () => {
  it('retries a runtime change after a missing system config returns', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    const baselineBeforeSourceLoss = readFileSync(baselinePath(), 'utf-8')

    rmSync(systemConfigPath())
    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('model = "o4"')
    expect(existsSync(systemConfigPath())).toBe(false)
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(baselineBeforeSourceLoss)

    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "o4"\n')
    expect(readRuntimeConfig()).toContain('model = "o4"')
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a restrictive mode on the existing ~/.codex/config.toml',
    () => {
      writeSystemConfig('model = "gpt-5"\n')
      chmodSync(systemConfigPath(), 0o600)
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(readSystemConfig()).toBe('model = "o4"\n')
      expect(statSync(systemConfigPath()).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'creates a new ~/.codex/config.toml with owner-only permissions',
    () => {
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(statSync(systemConfigPath()).mode & 0o777).toBe(0o600)
      // The home may later hold auth.json, so directory permissions must also be private.
      expect(statSync(join(tmpHome, '.codex')).mode & 0o777).toBe(0o700)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked config.toml without replacing the link',
    () => {
      mkdirSync(join(tmpHome, '.codex'), { recursive: true })
      const realConfigPath = join(tmpHome, 'dotfiles-config.toml')
      writeFileSync(realConfigPath, 'model = "gpt-5"\n', 'utf-8')
      symlinkSync(realConfigPath, systemConfigPath())
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(lstatSync(systemConfigPath()).isSymbolicLink()).toBe(true)
      expect(readFileSync(realConfigPath, 'utf-8')).toBe('model = "o4"\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves a dangling config.toml symlink and creates its target',
    () => {
      mkdirSync(join(tmpHome, '.codex'), { recursive: true })
      const realConfigPath = join(tmpHome, 'dotfiles', 'config.toml')
      symlinkSync(realConfigPath, systemConfigPath())
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(lstatSync(systemConfigPath()).isSymbolicLink()).toBe(true)
      expect(readFileSync(realConfigPath, 'utf-8')).toBe('model = "o4"\n')
    }
  )

  it('keeps the old baseline and retries after a transient promotion failure', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    const baselineBeforeFailure = readFileSync(baselinePath(), 'utf-8')
    simulateCodexSettingWrite('model', '"o4"')

    promotionTestState.failAtomicWrite = true
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).toBe('model = "o4"\n')
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(baselineBeforeFailure)

    promotionTestState.failAtomicWrite = false
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe('model = "o4"\n')
  })
})
