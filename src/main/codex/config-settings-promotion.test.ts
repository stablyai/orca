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
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as CodexFsUtils from '../codex-accounts/fs-utils'

// Bypass platform-specific socket paths so asserted config bytes stay host-independent.
vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
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

vi.mock('../codex-accounts/fs-utils', async (importOriginal) => {
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
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'

// Exact [tui] block written by Codex 0.144.6 config/batchWrite.
const CODEX_TUI_BLOCK =
  '[tui]\nstatus_line = ["model-with-reasoning", "task-progress"]\nstatus_line_use_colors = true\nterminal_title = ["model"]\ntheme = "dark-photon"\n'

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

function setRuntimeConfig(content: string): void {
  mkdirSync(runtimeHomeDir(), { recursive: true })
  writeFileSync(runtimeConfigPath(), content, 'utf-8')
}

function simulateCodexSettingRemoval(key: string): void {
  const existing = readFileSync(runtimeConfigPath(), 'utf-8')
  const linePattern = new RegExp(`^${key}[ \\t]*=.*\\n?`, 'm')
  writeFileSync(runtimeConfigPath(), existing.replace(linePattern, ''), 'utf-8')
}

describe('codex settings write-back promotion', () => {
  it('promotes an in-Codex model change to ~/.codex and reaches a steady state', () => {
    writeSystemConfig(
      'model = "gpt-5"\napproval_policy = "on-request"\n\n[features]\nhooks = true\n'
    )
    syncSystemConfigIntoManagedCodexHome()
    expect(existsSync(baselinePath())).toBe(true)

    simulateCodexSettingWrite('model', '"gpt-5.5-codex"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5.5-codex"\napproval_policy = "on-request"\n\n[features]\nhooks = true\n'
    )
    expect(readRuntimeConfig()).toContain('model = "gpt-5.5-codex"')

    const settledSystem = readSystemConfig()
    const settledRuntime = readRuntimeConfig()
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe(settledSystem)
    expect(readRuntimeConfig()).toBe(settledRuntime)
  })

  it('does not promote on the first pass without a baseline, then promotes after one', () => {
    writeSystemConfig('model = "gpt-5"\n')
    mkdirSync(runtimeHomeDir(), { recursive: true })
    writeFileSync(runtimeConfigPath(), 'model = "user-changed-before-upgrade"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).toContain('model = "gpt-5"')
    expect(existsSync(baselinePath())).toBe(true)

    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe('model = "o4"\n')
  })

  it('treats a corrupt baseline as missing and rewrites it', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(baselinePath(), 'not json', 'utf-8')

    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8'))).toMatchObject({ version: 3 })

    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe('model = "o4"\n')
  })

  it('lets an outside ~/.codex edit win over a conflicting in-Codex change', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('model', '"in-codex-choice"')
    writeSystemConfig('model = "outside-edit"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "outside-edit"\n')
    expect(readRuntimeConfig()).toContain('model = "outside-edit"')
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

  it('bootstraps a baseline while the system config is missing so promotion still arms', () => {
    setRuntimeConfig('model = "seeded"\n\n[features]\nhooks = true\n')

    syncSystemConfigIntoManagedCodexHome()

    expect(existsSync(systemConfigPath())).toBe(false)
    expect(existsSync(baselinePath())).toBe(true)
    expect(readRuntimeConfig()).toContain('[features]')

    simulateCodexSettingWrite('model', '"o4"')
    writeSystemConfig('model = "seeded"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "o4"\n')
    expect(readRuntimeConfig()).toContain('model = "o4"')
  })

  it('inserts a key ~/.codex lacks into the preamble without disturbing the rest', () => {
    writeSystemConfig('# my codex config\nmodel = "gpt-5"\n\n[features]\nhooks = true\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('approval_policy', '"on-request"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      '# my codex config\nmodel = "gpt-5"\napproval_policy = "on-request"\n\n[features]\nhooks = true\n'
    )
  })

  it('creates ~/.codex/config.toml when a user without one changes a setting', () => {
    expect(existsSync(join(tmpHome, '.codex'))).toBe(false)
    syncSystemConfigIntoManagedCodexHome()
    expect(existsSync(baselinePath())).toBe(true)

    simulateCodexSettingWrite('model', '"gpt-5.5-codex"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5.5-codex"\n')
    expect(readRuntimeConfig()).toContain('model = "gpt-5.5-codex"')
  })

  it('keeps runtime-only settings when promotion has to create ~/.codex/config.toml', () => {
    expect(existsSync(join(tmpHome, '.codex'))).toBe(false)
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig(
      '[features]\nhooks = true\n\n[mcp_servers.linear]\ncommand = "npx"\n\n[projects."/repo"]\ntrust_level = "trusted"\n'
    )
    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('[mcp_servers.linear]')
    expect(readRuntimeConfig()).toContain('[features]')
    expect(readRuntimeConfig()).toContain('model = "o4"')
    expect(readRuntimeConfig()).toContain('[projects."/repo"]')
    expect(readSystemConfig()).not.toContain('[projects."/repo"]')
    expect(readSystemConfig()).toContain('[mcp_servers.linear]')
  })

  it('does not promote a key deletion', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingRemoval('model')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).toContain('model = "gpt-5"')
  })

  it('ignores keys outside the allowlist', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('notify', '["custom-notifier"]')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
  })

  it('ignores allowlisted keys inside tables such as [profiles.*]', () => {
    writeSystemConfig('model = "gpt-5"\n\n[profiles.dev]\nmodel = "profile-model"\n')
    syncSystemConfigIntoManagedCodexHome()

    const runtime = readRuntimeConfig()
    writeFileSync(
      runtimeConfigPath(),
      runtime.replace('model = "profile-model"', 'model = "profile-changed"'),
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n\n[profiles.dev]\nmodel = "profile-model"\n')
  })

  it('never rewrites a multiline system value', () => {
    writeSystemConfig('model = """\nodd\nmultiline\n"""\n')
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(runtimeConfigPath(), 'model = "single"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = """\nodd\nmultiline\n"""\n')
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

  it('does not rewrite an unchanged settings baseline', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    const past = new Date(Date.now() - 120_000)
    utimesSync(baselinePath(), past, past)
    syncSystemConfigIntoManagedCodexHome()

    expect(statSync(baselinePath()).mtimeMs).toBeLessThan(Date.now() - 60_000)
  })

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

describe('codex [tui] settings write-back promotion', () => {
  it('promotes a runtime [tui] block (codex 0.144.6 shape) into ~/.codex and survives the remirror', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(runtimeConfigPath(), `${readRuntimeConfig()}\n${CODEX_TUI_BLOCK}`, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(`model = "gpt-5"\n\n${CODEX_TUI_BLOCK}`)
    const runtime = readRuntimeConfig()
    expect(runtime).toContain('status_line = ["model-with-reasoning", "task-progress"]')
    expect(runtime).toContain('status_line_use_colors = true')
    expect(runtime).toContain('terminal_title = ["model"]')
    expect(runtime).toContain('theme = "dark-photon"')

    const settledSystem = readSystemConfig()
    const settledRuntime = readRuntimeConfig()
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe(settledSystem)
    expect(readRuntimeConfig()).toBe(settledRuntime)
  })

  it('replaces a promoted key in an existing [tui] table, leaving non-promoted neighbors untouched', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\nanimations = true\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\nanimations = true\ntheme = "light"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\n\n[tui]\nanimations = true\ntheme = "light"\n'
    )
  })

  it('promotes a model change and a status-line change in one pass into their regions', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark-photon"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "o4"\n\n[tui]\ntheme = "dark-photon"\nstatus_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "o4"\n\n[tui]\ntheme = "dark-photon"\nstatus_line = ["model"]\n'
    )
  })

  it('detects and replaces a dotted-form system tui key without creating a [tui] table', () => {
    writeSystemConfig('model = "gpt-5"\ntui.theme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\ntui.theme = "light"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\ntui.theme = "light"\n')
    expect(readSystemConfig()).not.toContain('[tui]')
  })

  it('promotes through a quoted tui table without creating a duplicate table', () => {
    writeSystemConfig('model = "gpt-5"\n\n["tui"]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n["tui"]\ntheme = "light"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n\n["tui"]\ntheme = "light"\n')
    expect(readSystemConfig()).not.toContain('\n[tui]\n')
  })

  it('inserts dotted beside a non-promoted dotted tui key instead of creating a [tui] table', () => {
    // A dotted tui key already defines the table; appending [tui] would duplicate it.
    writeSystemConfig('model = "gpt-5"\ntui.pet = "cat"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\ntui.pet = "cat"\ntui.theme = "dark-photon"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\ntui.pet = "cat"\ntui.theme = "dark-photon"\n')
    expect(readSystemConfig()).not.toContain('[tui]')
  })

  it('creates a [tui] table at EOF when the only tui presence is a subtable', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui.notifications]\nenabled = true\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig(
      'model = "gpt-5"\n\n[tui.notifications]\nenabled = true\n\n[tui]\nstatus_line = ["model"]\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\n\n[tui.notifications]\nenabled = true\n\n[tui]\nstatus_line = ["model"]\n'
    )
  })

  it('inserts a promoted key into a CRLF system [tui] table preserving CRLF', () => {
    writeSystemConfig('model = "gpt-5"\r\n\r\n[tui]\r\ntheme = "dark"\r\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\nstatus_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    const system = readSystemConfig()
    expect(system).toContain('status_line = ["model"]\r\n')
    expect(system).toBe(
      'model = "gpt-5"\r\n\r\n[tui]\r\ntheme = "dark"\r\nstatus_line = ["model"]\r\n'
    )
  })

  it('never appends a [tui] table when the system config defines tui inline', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    // An inline tui table prevents appending [tui] for the concurrent runtime edit.
    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark-photon"\n')
    writeSystemConfig('model = "gpt-5"\ntui = { animations = false }\n')
    promotionTestState.atomicWritePaths.length = 0
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\ntui = { animations = false }\n')
    expect(promotionTestState.atomicWritePaths).not.toContain(systemConfigPath())
  })

  it('ignores an allowlisted key nested under a [tui.*] subtable', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui.notifications]\ntheme = "should-not-promote"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui.notifications]\ntheme = "changed-in-subtable"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\n\n[tui.notifications]\ntheme = "should-not-promote"\n'
    )
  })
})

describe('upsertPromotedSettingsInContent', () => {
  it('drops an absent scalar that would redefine an existing tui key table', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[tui."theme"]\nvariant = "dark"\n',
        new Map([['tui.theme', '"light"']])
      )
    ).toBe('[tui."theme"]\nvariant = "dark"\n')
  })

  it('drops an absent scalar that would redefine a dotted tui key table', () => {
    expect(
      upsertPromotedSettingsInContent(
        'tui.theme.variant = "dark"\n',
        new Map([['tui.theme', '"light"']])
      )
    ).toBe('tui.theme.variant = "dark"\n')
  })

  it('does not mistake a dotted tui key inside an array table for a root key', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[[profiles]]\ntui.theme = "profile-theme"\n',
        new Map([['tui.theme', '"root-theme"']])
      )
    ).toBe('[[profiles]]\ntui.theme = "profile-theme"\n\n[tui]\ntheme = "root-theme"\n')
  })

  it('does not append a table beside a root tui array-of-tables', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[[tui]]\ntheme = "array-theme"\n',
        new Map([['tui.theme', '"root-theme"']])
      )
    ).toBe('[[tui]]\ntheme = "array-theme"\n')
  })
})
