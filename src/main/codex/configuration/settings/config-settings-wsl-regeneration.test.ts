import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as WslPaths from '../../../../shared/file-access/wsl-paths'

const { homedirMock, wslTestState } = vi.hoisted(() => {
  const state: { wslPath: string | null; daemonGuard: boolean; failTempWrite: boolean } = {
    wslPath: null,
    daemonGuard: false,
    failTempWrite: false
  }
  return { homedirMock: vi.fn<() => string>(), wslTestState: state }
})

vi.mock('../shared-server/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  codexDaemonSocketPathExceedsLimit: () => wslTestState.daemonGuard
}))

vi.mock('../../../../shared/file-access/wsl-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof WslPaths>()
  return {
    ...actual,
    parseWslUncPath: (path: string) =>
      path === wslTestState.wslPath
        ? { distro: 'Ubuntu', linuxPath: '/home/u/.codex/config.toml' }
        : actual.parseWslUncPath(path)
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (wslTestState.failTempWrite && String(args[0]).endsWith('.tmp')) {
        // A disk that fills partway through the temp file.
        actual.writeFileSync(args[0], String(args[1]).slice(0, 5))
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return actual.writeFileSync(...args)
    }
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-regen-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-regen-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  wslTestState.wslPath = null
  wslTestState.daemonGuard = false
  wslTestState.failTempWrite = false
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

const systemConfigPath = (): string => join(tmpHome, '.codex', 'config.toml')
const runtimeConfigPath = (): string =>
  join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
const readRuntimeConfig = (): string => readFileSync(runtimeConfigPath(), 'utf-8')

function writeSystemConfig(content: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

function simulateCodexSettingWrite(key: string, rawValue: string): void {
  mkdirSync(join(runtimeConfigPath(), '..'), { recursive: true })
  const existing = existsSync(runtimeConfigPath()) ? readRuntimeConfig() : ''
  const line = new RegExp(`^${key} = .*$`, 'm')
  const rendered = `${key} = ${rawValue}`
  writeFileSync(
    runtimeConfigPath(),
    line.test(existing) ? existing.replace(line, rendered) : `${rendered}\n${existing}`,
    'utf-8'
  )
}

describe('managed Codex config for a WSL distro config', () => {
  it('replaces a tab change at the next regeneration and never writes the distro config', () => {
    const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example"\n'
    writeSystemConfig(original)
    wslTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    // A running Codex saves into the managed copy right after a regeneration.
    simulateCodexSettingWrite('model', '"o4"')
    writeFileSync(
      runtimeConfigPath(),
      `${readRuntimeConfig()}\n[plugins."ponytail@ponytail"]\nenabled = true\n`,
      'utf-8'
    )
    wslTestState.daemonGuard = true

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(readRuntimeConfig()).toContain('model = "gpt-5"')
    expect(readRuntimeConfig()).toContain('[mcp_servers.docs]')
    expect(readRuntimeConfig()).not.toContain('ponytail')
    expect(readRuntimeConfig()).toMatch(/^daemon_auto_start = false # orca:/m)
  })

  it('leaves an unchanged managed copy untouched on regeneration', () => {
    writeSystemConfig(
      'model = "gpt-5"\n\n[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n\n[projects."/home/u/repo"]\ntrust_level = "trusted"\n'
    )
    wslTestState.wslPath = systemConfigPath()
    wslTestState.daemonGuard = true
    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()
    const before = statSync(runtimeConfigPath())

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    const after = statSync(runtimeConfigPath())
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('leaves the managed copy whole when a regeneration write fails partway', () => {
    writeSystemConfig('model = "gpt-5"\n')
    wslTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    const beforeFailedWrite = readRuntimeConfig()
    writeSystemConfig('model = "o5"\n')

    wslTestState.failTempWrite = true
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toBe(beforeFailedWrite)
    const leftovers = readdirSync(join(runtimeConfigPath(), '..')).filter((name) =>
      name.endsWith('.tmp')
    )
    expect(leftovers).toEqual([])
    wslTestState.failTempWrite = false
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toBe('model = "o5"\n')
  })

  it.skipIf(process.platform === 'win32')(
    'never creates a config in a distro through a linked ~/.codex folder',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      wslTestState.wslPath = join(realpathSync(guestCodexDir), 'config.toml')
      simulateCodexSettingWrite('approval_policy', '"never"')
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(existsSync(join(guestCodexDir, 'config.toml'))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'drops a held-back conflict for a ~/.codex linked into a distro',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      writeSystemConfig('approval_policy = "never"\n')
      syncSystemConfigIntoManagedCodexHome()
      // A baseline from before `model` was tracked, so diverging values are held back as a conflict.
      const baselinePath = join(runtimeConfigPath(), '..', '.orca-config-settings-baseline.json')
      const stored = JSON.parse(readFileSync(baselinePath, 'utf-8'))
      delete stored.settings.model
      writeFileSync(baselinePath, JSON.stringify(stored), 'utf-8')
      simulateCodexSettingWrite('model', '"o4"')
      writeSystemConfig('model = "o5"\napproval_policy = "never"\n')
      syncSystemConfigIntoManagedCodexHome()
      expect(readRuntimeConfig()).toContain('model = "o4"')
      wslTestState.wslPath = join(realpathSync(guestCodexDir), 'config.toml')

      syncSystemConfigIntoManagedCodexHome()

      expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(
        'model = "o5"\napproval_policy = "never"\n'
      )
      expect(readRuntimeConfig()).toContain('model = "o5"')
    }
  )
})
