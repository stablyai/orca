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
import {
  upsertPromotedSettingsInContent,
  upsertTopLevelSettingsInContent
} from './codex-config-settings-upsert'

// The exact [tui] block codex 0.144.6 writes via config/batchWrite (all four
// promoted keys single-line, theme a string).
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
  // Why: promotion writes into homedir()/.codex — if the mock ever fails to
  // intercept, these tests would rewrite the developer's real Codex config.
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

// Mimics how Codex (toml_edit) persists a /model or /approvals change: the
// top-level key line is rewritten in place, or created when absent.
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

// Codex reads then rewrites the whole runtime config; simulate that by writing
// a known runtime config directly (its EOL is normalized by the mirror anyway).
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

  it('promotes multiple approvals keys in one pass', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('approval_policy', '"never"')
    simulateCodexSettingWrite('sandbox_mode', '"danger-full-access"')
    syncSystemConfigIntoManagedCodexHome()

    const system = readSystemConfig()
    expect(system).toContain('approval_policy = "never"')
    expect(system).toContain('sandbox_mode = "danger-full-access"')
    expect(system).toContain('model = "gpt-5"')
  })

  it('does not promote on the first pass without a baseline, then promotes after one', () => {
    writeSystemConfig('model = "gpt-5"\n')
    mkdirSync(runtimeHomeDir(), { recursive: true })
    // Pre-upgrade state: runtime already diverged, but no baseline exists.
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
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8'))).toMatchObject({ version: 1 })

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
    // Why: no mkdir of ~/.codex here — a genuinely fresh host has neither the
    // config nor its directory, and promotion must create both.
    expect(existsSync(join(tmpHome, '.codex'))).toBe(false)
    syncSystemConfigIntoManagedCodexHome()
    expect(existsSync(baselinePath())).toBe(true)

    // Codex itself creates the runtime config.toml on the first /model write.
    simulateCodexSettingWrite('model', '"gpt-5.5-codex"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5.5-codex"\n')
    expect(readRuntimeConfig()).toContain('model = "gpt-5.5-codex"')
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

  it('preserves CRLF line endings when replacing a value', () => {
    writeSystemConfig('model = "gpt-5"\r\napproval_policy = "on-request"\r\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('model = "o4"\r\n')
    expect(readSystemConfig()).toContain('approval_policy = "on-request"\r\n')
  })

  it('promotes over a value that carried an inline comment', () => {
    writeSystemConfig('model = "gpt-5" # my favorite\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "o4"\n')
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
      // The created ~/.codex itself is owner-only — it will also hold
      // auth.json once the user signs in.
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

  it('inserts a missing key into a CRLF config with CRLF endings', () => {
    writeSystemConfig('model = "gpt-5"\r\n\r\n[features]\r\nhooks = true\r\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexSettingWrite('approval_policy', '"never"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\r\napproval_policy = "never"\r\n\r\n[features]\r\nhooks = true\r\n'
    )
  })

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

    // The user customizes the status line/theme inside Orca-launched Codex.
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

  it('promotes a changed status_line array value', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\nstatus_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig(
      'model = "gpt-5"\n\n[tui]\nstatus_line = ["model-with-reasoning", "task-progress"]\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\n\n[tui]\nstatus_line = ["model-with-reasoning", "task-progress"]\n'
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

    // toml_edit preserves the dotted form when codex rewrites the value.
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

  it('inserts a second dotted tui key beside an existing dotted-only tui config', () => {
    writeSystemConfig('model = "gpt-5"\ntui.theme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\ntui.theme = "dark"\ntui.status_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\ntui.theme = "dark"\ntui.status_line = ["model"]\n'
    )
    expect(readSystemConfig()).not.toContain('[tui]')
  })

  it('inserts dotted beside a non-promoted dotted tui key instead of creating a [tui] table', () => {
    // Why: any dotted tui.* key already defines the implicit tui table, so a
    // fresh [tui] table at EOF would be a duplicate-definition parse error.
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

  it('creates exactly one [tui] table for two keys promoted in one pass', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark-photon"\nstatus_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    const system = readSystemConfig()
    expect(system.match(/^\[tui\]$/gm)?.length).toBe(1)
    expect(system).toBe(
      'model = "gpt-5"\n\n[tui]\nstatus_line = ["model"]\ntheme = "dark-photon"\n'
    )
  })

  it('lets an outside ~/.codex [tui] edit win over a conflicting in-Codex tui change', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "in-codex"\n')
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "outside-edit"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n\n[tui]\ntheme = "outside-edit"\n')
    expect(readRuntimeConfig()).toContain('theme = "outside-edit"')
  })

  it('does not promote a [tui] key deletion', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('theme = "dark"')
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

    // In-Codex tui change racing an outside edit that adds an inline tui table:
    // appending [tui] would make the system config unparseable, so the change
    // is dropped instead.
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
  it('replaces a bare key in place inside the [tui] table', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[tui]\ntheme = "dark"\n',
        new Map([['tui.theme', '"light"']])
      )
    ).toBe('[tui]\ntheme = "light"\n')
  })

  it('inserts a bare key at the end of the [tui] body, before a subtable', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[tui]\ntheme = "dark"\n\n[tui.notifications]\nenabled = true\n',
        new Map([['tui.status_line', '["model"]']])
      )
    ).toBe(
      '[tui]\ntheme = "dark"\nstatus_line = ["model"]\n\n[tui.notifications]\nenabled = true\n'
    )
  })

  it('replaces a dotted preamble tui key in place, keeping the dotted form', () => {
    expect(
      upsertPromotedSettingsInContent('tui.theme = "dark"\n', new Map([['tui.theme', '"light"']]))
    ).toBe('tui.theme = "light"\n')
  })

  it('inserts a dotted tui key beside an existing dotted tui key', () => {
    expect(
      upsertPromotedSettingsInContent(
        'tui.theme = "dark"\n\n[features]\nx = 1\n',
        new Map([['tui.status_line', '["model"]']])
      )
    ).toBe('tui.theme = "dark"\ntui.status_line = ["model"]\n\n[features]\nx = 1\n')
  })

  it('creates a [tui] table from empty content', () => {
    expect(upsertPromotedSettingsInContent('', new Map([['tui.theme', '"dark"']]))).toBe(
      '[tui]\ntheme = "dark"\n'
    )
  })

  it('drops an absent key instead of appending [tui] beside an inline tui table', () => {
    expect(
      upsertPromotedSettingsInContent(
        'tui = { animations = false }\n',
        new Map([['tui.theme', '"dark"']])
      )
    ).toBe('tui = { animations = false }\n')
  })

  it('drops an absent key beside a quoted inline tui table', () => {
    expect(
      upsertPromotedSettingsInContent(
        '"tui" = { animations = false }\n',
        new Map([['tui.theme', '"dark"']])
      )
    ).toBe('"tui" = { animations = false }\n')
  })

  it('inserts beside a quoted dotted tui key instead of appending a table', () => {
    expect(
      upsertPromotedSettingsInContent('"tui" . "pet" = "cat"\n', new Map([['tui.theme', '"dark"']]))
    ).toBe('"tui" . "pet" = "cat"\ntui.theme = "dark"\n')
  })

  it('creates a [tui] super-table at EOF after a [tui.*] subtable', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[tui.notifications]\nenabled = true\n',
        new Map([['tui.theme', '"dark"']])
      )
    ).toBe('[tui.notifications]\nenabled = true\n\n[tui]\ntheme = "dark"\n')
  })

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

  it('does not append a table beside a quoted root tui array-of-tables', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[["tui"]]\ntheme = "array-theme"\n',
        new Map([['tui.theme', '"root-theme"']])
      )
    ).toBe('[["tui"]]\ntheme = "array-theme"\n')
  })

  it('creates one [tui] table for multiple keys reaching the new-table branch', () => {
    expect(
      upsertPromotedSettingsInContent(
        '',
        new Map([
          ['tui.status_line', '["model"]'],
          ['tui.theme', '"dark"']
        ])
      )
    ).toBe('[tui]\nstatus_line = ["model"]\ntheme = "dark"\n')
  })

  it('routes a mixed top-level + tui batch to its two regions in one rewrite', () => {
    expect(
      upsertPromotedSettingsInContent(
        'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n',
        new Map([
          ['model', '"o4"'],
          ['tui.theme', '"light"']
        ])
      )
    ).toBe('model = "o4"\n\n[tui]\ntheme = "light"\n')
  })

  it('inserts into a CRLF [tui] table with CRLF endings', () => {
    expect(
      upsertPromotedSettingsInContent(
        '[tui]\r\ntheme = "dark"\r\n',
        new Map([['tui.status_line', '["model"]']])
      )
    ).toBe('[tui]\r\ntheme = "dark"\r\nstatus_line = ["model"]\r\n')
  })
})

describe('upsertTopLevelSettingsInContent', () => {
  it('writes into empty content', () => {
    expect(upsertTopLevelSettingsInContent('', new Map([['model', '"x"']]))).toBe('model = "x"\n')
  })

  it('inserts before the first table with a separating blank line', () => {
    expect(
      upsertTopLevelSettingsInContent('[features]\nhooks = true\n', new Map([['model', '"x"']]))
    ).toBe('model = "x"\n\n[features]\nhooks = true\n')
  })

  it('appends to a preamble-only file without a trailing newline', () => {
    expect(
      upsertTopLevelSettingsInContent('approval_policy = "never"', new Map([['model', '"x"']]))
    ).toBe('approval_policy = "never"\nmodel = "x"\n')
  })

  it('replaces the existing line in place', () => {
    expect(
      upsertTopLevelSettingsInContent(
        '# keep\nmodel = "old"\n\n[t]\nk = 1\n',
        new Map([['model', '"new"']])
      )
    ).toBe('# keep\nmodel = "new"\n\n[t]\nk = 1\n')
  })

  it('replaces a quoted top-level key instead of adding its bare equivalent', () => {
    expect(
      upsertTopLevelSettingsInContent('"model" = "old"\n', new Map([['model', '"new"']]))
    ).toBe('model = "new"\n')
  })

  it('inserts with CRLF endings into CRLF content', () => {
    expect(
      upsertTopLevelSettingsInContent('[features]\r\nhooks = true\r\n', new Map([['model', '"x"']]))
    ).toBe('model = "x"\r\n\r\n[features]\r\nhooks = true\r\n')
  })

  it('appends with CRLF to a CRLF preamble-only file', () => {
    expect(
      upsertTopLevelSettingsInContent('approval_policy = "never"\r\n', new Map([['model', '"x"']]))
    ).toBe('approval_policy = "never"\r\nmodel = "x"\r\n')
  })
})
