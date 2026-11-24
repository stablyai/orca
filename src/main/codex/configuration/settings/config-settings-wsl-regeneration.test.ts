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
import { parse as parseToml } from 'smol-toml'
import type * as WslPaths from '../../../../shared/file-access/wsl-paths'
import type * as Promotion from './config-settings-promotion'

const { homedirMock, wslTestState } = vi.hoisted(() => {
  const state: {
    wslPath: string | null
    daemonGuard: boolean
    failTempWrite: boolean
    failTempWriteMatch: string | null
    unresolvablePath: string | null
    afterPromotion: (() => void) | null
  } = {
    wslPath: null,
    daemonGuard: false,
    failTempWrite: false,
    failTempWriteMatch: null,
    unresolvablePath: null,
    afterPromotion: null
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
  const realpathSync = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) => {
      if (String(args[0]) === wslTestState.unresolvablePath) {
        // Windows can refuse to resolve a folder link into a distro.
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return actual.realpathSync(...args)
    },
    { native: actual.realpathSync.native }
  )
  return {
    ...actual,
    realpathSync,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const path = String(args[0])
      if (
        wslTestState.failTempWrite &&
        // A named file fails wherever it is written, so an in-place write is cut off too.
        (wslTestState.failTempWriteMatch
          ? path.includes(wslTestState.failTempWriteMatch)
          : path.endsWith('.tmp'))
      ) {
        // A disk that fills partway through the temp file.
        actual.writeFileSync(args[0], String(args[1]).slice(0, 5))
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return actual.writeFileSync(...args)
    }
  }
})

vi.mock('./config-settings-promotion', async (importOriginal) => {
  const actual = await importOriginal<typeof Promotion>()
  return {
    ...actual,
    promoteCodexRuntimeSettingsToSystem: (
      ...args: Parameters<typeof actual.promoteCodexRuntimeSettingsToSystem>
    ) => {
      const plan = actual.promoteCodexRuntimeSettingsToSystem(...args)
      // A save in the distro that lands after promotion and before the mirror's read.
      wslTestState.afterPromotion?.()
      return plan
    }
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion
} from './config-plugin-registration-promotion'

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
  wslTestState.failTempWriteMatch = null
  wslTestState.unresolvablePath = null
  wslTestState.afterPromotion = null
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

  it('keeps edits pending in a managed copy from before the update as Orca lines', () => {
    const original =
      'model = "gpt-5"\n\n[plugins."docs@market"]\nenabled = true\n\n[mcp_servers.docs]\nurl = "https://docs.example"\n'
    writeSystemConfig(original)
    // The previous version mirrored this home and left later tab edits for its next pass.
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    writeFileSync(
      runtimeConfigPath(),
      readRuntimeConfig()
        .replace('enabled = true', 'enabled = false')
        .concat('\n[plugins."ponytail@ponytail"]\nenabled = true\n'),
      'utf-8'
    )
    wslTestState.wslPath = systemConfigPath()

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(readRuntimeConfig()).toMatch(/^model = "o4" # orca: /m)
    expect(readRuntimeConfig()).toMatch(/^enabled = false # orca: /m)
    expect(readRuntimeConfig().match(/\[plugins\."ponytail@ponytail"\]/g)).toHaveLength(1)
    // A later tab change is still replaced; an edit to the distro file wins over the kept line.
    simulateCodexSettingWrite('model', '"o3"')
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toMatch(/^model = "o4" # orca: /m)
    writeSystemConfig(original.replace('"gpt-5"', '"gpt-6"'))
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toMatch(/^model = "gpt-6"$/m)
    expect(readRuntimeConfig()).toMatch(/^enabled = false # orca: /m)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a pending edit for a ~/.codex linked into a distro across later passes',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      writeFileSync(join(guestCodexDir, 'config.toml'), 'model = "gpt-5"\n', 'utf-8')
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      syncSystemConfigIntoManagedCodexHome()
      simulateCodexSettingWrite('model', '"o4"')
      wslTestState.wslPath = join(realpathSync(guestCodexDir), 'config.toml')

      syncSystemConfigIntoManagedCodexHome()
      syncSystemConfigIntoManagedCodexHome()

      expect(readFileSync(systemConfigPath(), 'utf-8')).toBe('model = "gpt-5"\n')
      expect(readRuntimeConfig()).toMatch(/^model = "o4" # orca: /m)
    }
  )

  it('appends a plugin table to a CRLF config without doubling carriage returns', () => {
    const crlfConfig = 'model = "gpt-5"\r\n'
    const runtimeConfig = `${crlfConfig}\r\n[plugins."ponytail@ponytail"]\r\nenabled = true\r\n`

    expect(
      applyCodexRegistrationPromotions(
        crlfConfig,
        planCodexRegistrationPromotion(runtimeConfig, crlfConfig, new Map())
      )
    ).toBe(runtimeConfig)
  })

  it('does not bring back a plugin the distro dropped when the baseline predates plugin tracking', () => {
    writeSystemConfig('model = "gpt-5"\n\n[plugins."old@market"]\nenabled = true\n')
    syncSystemConfigIntoManagedCodexHome()
    const baselinePath = join(runtimeConfigPath(), '..', '.orca-config-settings-baseline.json')
    const stored = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    stored.version = 2
    delete stored.registrations
    delete stored.mcpServers
    writeFileSync(baselinePath, JSON.stringify(stored), 'utf-8')
    writeSystemConfig('model = "gpt-5"\n')
    wslTestState.wslPath = systemConfigPath()

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('old@market')
  })

  it('keeps a kept value whole when the baseline write is cut off', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    wslTestState.wslPath = systemConfigPath()
    wslTestState.failTempWrite = true
    wslTestState.failTempWriteMatch = '.orca-config-settings-baseline.json'

    syncSystemConfigIntoManagedCodexHome()
    wslTestState.failTempWrite = false
    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toMatch(
      /^model = "o4" # orca: tab edit kept from before the update$/m
    )
    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('lets a distro save made during a pass win over a kept value', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    wslTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    wslTestState.afterPromotion = () => writeSystemConfig('model = "gpt-6"\n')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toMatch(/^model = "gpt-6"$/m)
  })

  it.each([
    'model = "gpt-5"\nplugins = { "docs@market" = { enabled = true } }\n',
    'model = "gpt-5"\nplugins."docs@market".enabled = true\n',
    'model = "gpt-5"\n\n[plugins]\n"docs@market" = { enabled = true }\n'
  ])('never redefines a plugin the distro defines inline: %j', (distro) => {
    writeSystemConfig(distro)
    syncSystemConfigIntoManagedCodexHome()
    // Codex writes a toggle as its own table.
    writeFileSync(
      runtimeConfigPath(),
      `${readRuntimeConfig()}\n[plugins."docs@market"]\nenabled = false\n\n[plugins."new@market"]\nenabled = true\n`,
      'utf-8'
    )
    wslTestState.wslPath = systemConfigPath()

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(() => parseToml(readRuntimeConfig())).not.toThrow()
    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(distro)
  })

  it('keeps a first plugin added in a tab before the update', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(
      runtimeConfigPath(),
      `${readRuntimeConfig()}\n[plugins."docs@market"]\nenabled = true\n`,
      'utf-8'
    )
    wslTestState.wslPath = systemConfigPath()

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).toContain('[plugins."docs@market"]')
  })

  it('does not hold managed-copy plugins against a starter baseline', () => {
    writeSystemConfig('')
    wslTestState.wslPath = systemConfigPath()
    simulateCodexSettingWrite('model', '"gpt-5"')
    writeFileSync(
      runtimeConfigPath(),
      `${readRuntimeConfig()}\n[plugins."stale@market"]\nenabled = true\n`,
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()
    writeSystemConfig('model = "gpt-5"\n')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('stale@market')
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
    'never writes through a linked ~/.codex folder that cannot be resolved',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      wslTestState.unresolvablePath = join(tmpHome, '.codex')
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
