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
  promotionTestState: { failAtomicWrite: false }
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
      if (promotionTestState.failAtomicWrite) {
        throw new Error('injected atomic write failure')
      }
      return actual.writeFileAtomically(...args)
    }
  }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { upsertTopLevelSettingsInContent } from './config-settings-promotion'

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
