import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as TomlAtomicWrite from '../toml/config-toml-atomic-write'
import type * as WslPaths from '../../../../shared/file-access/wsl-paths'

// Bypass platform-specific socket paths so asserted config bytes stay host-independent.
vi.mock('../shared-server/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  codexDaemonSocketPathExceedsLimit: () => promotionTestState.daemonGuard
}))

const { homedirMock, promotionTestState } = vi.hoisted(() => {
  const state: {
    failAtomicWrite: boolean
    wslSystemConfigPath: string | null
    daemonGuard: boolean
  } = {
    failAtomicWrite: false,
    wslSystemConfigPath: null,
    daemonGuard: false
  }
  return { homedirMock: vi.fn<() => string>(), promotionTestState: state }
})

vi.mock('../../../../shared/file-access/wsl-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof WslPaths>()
  return {
    ...actual,
    parseWslUncPath: (path: string) =>
      path === promotionTestState.wslSystemConfigPath
        ? { distro: 'Ubuntu', linuxPath: '/home/u/.codex/config.toml' }
        : actual.parseWslUncPath(path)
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

vi.mock('../toml/config-toml-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof TomlAtomicWrite>()
  return {
    ...actual,
    writeTomlConfigAtomically: (...args: Parameters<typeof actual.writeTomlConfigAtomically>) => {
      if (promotionTestState.failAtomicWrite) {
        throw new Error('injected atomic write failure')
      }
      return actual.writeTomlConfigAtomically(...args)
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
  promotionTestState.wslSystemConfigPath = null
  promotionTestState.daemonGuard = false
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
  it('keeps runtime edits in the managed home instead of writing a WSL guest config', () => {
    const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example"\n'
    writeSystemConfig(original)
    promotionTestState.wslSystemConfigPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    writeFileSync(
      runtimeConfigPath(),
      `${readRuntimeConfig()}\n[plugins."ponytail@ponytail"]\nenabled = true\n`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(original)
    expect(readRuntimeConfig()).toContain('model = "o4"')
    expect(readRuntimeConfig()).toContain('[plugins."ponytail@ponytail"]')

    writeSystemConfig(original.replace('"gpt-5"', '"o5"'))
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('model = "o5"')
    expect(readRuntimeConfig()).toContain('[plugins."ponytail@ponytail"]')
  })

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

  it('keeps a WSL pane daemon preference while the daemon override hides it', () => {
    const original = 'model = "gpt-5"\n'
    writeSystemConfig(original)
    promotionTestState.wslSystemConfigPath = systemConfigPath()
    promotionTestState.daemonGuard = true
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(
      runtimeConfigPath(),
      `${readRuntimeConfig().replace(/^daemon_auto_start = .*$/m, 'daemon_auto_start = true')}`,
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()
    promotionTestState.daemonGuard = false
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(original)
    expect(readRuntimeConfig()).toMatch(/^daemon_auto_start = true$/m)
  })

  it.skipIf(process.platform === 'win32')(
    'does not write through a config.toml symlink into a WSL guest',
    () => {
      mkdirSync(join(tmpHome, '.codex'), { recursive: true })
      const guestConfigPath = join(tmpHome, 'guest-config.toml')
      writeFileSync(guestConfigPath, 'model = "gpt-5"\n', 'utf-8')
      symlinkSync(guestConfigPath, systemConfigPath())
      promotionTestState.wslSystemConfigPath = realpathSync(guestConfigPath)
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(readFileSync(guestConfigPath, 'utf-8')).toBe('model = "gpt-5"\n')
      expect(readRuntimeConfig()).toContain('model = "o4"')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not create a config.toml in a WSL guest through a linked ~/.codex folder',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      promotionTestState.wslSystemConfigPath = join(realpathSync(guestCodexDir), 'config.toml')
      simulateCodexSettingWrite('approval_policy', '"never"')
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(existsSync(join(guestCodexDir, 'config.toml'))).toBe(false)
      expect(readRuntimeConfig()).toContain('model = "o4"')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not create a dangling link target in a WSL guest through a linked ~/.codex folder',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      symlinkSync('config.private.toml', join(guestCodexDir, 'config.toml'))
      promotionTestState.wslSystemConfigPath = join(
        realpathSync(guestCodexDir),
        'config.private.toml'
      )
      simulateCodexSettingWrite('approval_policy', '"never"')
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(existsSync(join(guestCodexDir, 'config.private.toml'))).toBe(false)
      expect(readRuntimeConfig()).toContain('model = "o4"')
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
