import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-settings-upgrade-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-settings-upgrade-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
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

function runtimeHomePath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function runtimeConfigPath(): string {
  return join(runtimeHomePath(), 'config.toml')
}

function baselinePath(): string {
  return join(runtimeHomePath(), '.orca-config-settings-baseline.json')
}

function prepareLegacyState(systemConfig: string, runtimeConfig: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  mkdirSync(runtimeHomePath(), { recursive: true })
  writeFileSync(systemConfigPath(), systemConfig, 'utf-8')
  writeFileSync(runtimeConfigPath(), runtimeConfig, 'utf-8')
  writeFileSync(
    baselinePath(),
    `${JSON.stringify({ version: 1, settings: { model: '"gpt-5"' } }, null, 2)}\n`,
    'utf-8'
  )
}

function readBaseline(): {
  version: number
  settings: Record<string, string | null>
  conflicts?: Record<string, { runtime: string | null; system: string | null }>
} {
  return JSON.parse(readFileSync(baselinePath(), 'utf-8'))
}

describe('Codex settings baseline schema upgrade', () => {
  it('upgrades an aligned legacy baseline without creating a conflict', () => {
    const config = 'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n'
    prepareLegacyState(config, config)

    syncSystemConfigIntoManagedCodexHome()

    expect(readBaseline()).toMatchObject({
      version: 2,
      settings: { model: '"gpt-5"', 'tui.theme': '"dark"' }
    })
    expect(readBaseline().conflicts).toBeUndefined()
  })

  it('anchors a schema-new conflict while promoting an unrelated known key', () => {
    prepareLegacyState(
      'model = "gpt-5"\n\n[tui]\ntheme = "system"\n',
      'model = "o4"\n\n[tui]\ntheme = "runtime"\n'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('model = "o4"')
    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('theme = "system"')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('theme = "runtime"')
    expect(readBaseline().conflicts).toEqual({
      'tui.theme': { runtime: '"runtime"', system: '"system"' }
    })
  })

  it('promotes the runtime side when its anchored value changes', () => {
    prepareLegacyState(
      'model = "gpt-5"\n\n[tui]\ntheme = "system"\n',
      'model = "gpt-5"\n\n[tui]\ntheme = "runtime"\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(
      runtimeConfigPath(),
      readFileSync(runtimeConfigPath(), 'utf-8').replace('theme = "runtime"', 'theme = "chosen"'),
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('theme = "chosen"')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('theme = "chosen"')
    expect(readBaseline().conflicts).toBeUndefined()
    expect(readBaseline().settings['tui.theme']).toBe('"chosen"')
  })

  it('accepts the system side when its anchored value changes', () => {
    prepareLegacyState(
      'model = "gpt-5"\n\n[tui]\ntheme = "system"\n',
      'model = "gpt-5"\n\n[tui]\ntheme = "runtime"\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(
      systemConfigPath(),
      readFileSync(systemConfigPath(), 'utf-8').replace('theme = "system"', 'theme = "outside"'),
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('theme = "outside"')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('theme = "outside"')
    expect(readBaseline().conflicts).toBeUndefined()
  })

  it('ignores unrelated config writes while a value pair is anchored', () => {
    prepareLegacyState(
      'model = "gpt-5"\n\n[tui]\ntheme = "system"\n',
      'model = "gpt-5"\n\n[tui]\ntheme = "runtime"\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(
      runtimeConfigPath(),
      `${readFileSync(runtimeConfigPath(), 'utf-8')}\n[projects."/tmp/repo"]\ntrust_level = "trusted"\n`,
      'utf-8'
    )
    writeFileSync(
      systemConfigPath(),
      `${readFileSync(systemConfigPath(), 'utf-8')}\n[features]\nhooks = true\n`,
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('theme = "system"')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('theme = "runtime"')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('[projects."/tmp/repo"]')
    expect(readBaseline().conflicts).toEqual({
      'tui.theme': { runtime: '"runtime"', system: '"system"' }
    })
  })

  it('re-anchors two new divergent values until one side changes again', () => {
    prepareLegacyState(
      'model = "gpt-5"\n\n[tui]\ntheme = "system"\n',
      'model = "gpt-5"\n\n[tui]\ntheme = "runtime"\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(
      runtimeConfigPath(),
      readFileSync(runtimeConfigPath(), 'utf-8').replace(
        'theme = "runtime"',
        'theme = "runtime-2"'
      ),
      'utf-8'
    )
    writeFileSync(
      systemConfigPath(),
      readFileSync(systemConfigPath(), 'utf-8').replace('theme = "system"', 'theme = "system-2"'),
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readBaseline().conflicts).toEqual({
      'tui.theme': { runtime: '"runtime-2"', system: '"system-2"' }
    })
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('theme = "runtime-2"')
  })

  it('preserves an absent runtime value until the user chooses one', () => {
    prepareLegacyState('model = "gpt-5"\n\n[tui]\ntheme = "system"\n', 'model = "gpt-5"\n')

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(runtimeConfigPath(), 'utf-8')).not.toContain('theme =')
    expect(readBaseline().conflicts).toEqual({
      'tui.theme': { runtime: null, system: '"system"' }
    })

    writeFileSync(runtimeConfigPath(), 'model = "gpt-5"\n\n[tui]\ntheme = "chosen"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('theme = "chosen"')
    expect(readBaseline().conflicts).toBeUndefined()
  })

  it('applies the migration rule to future top-level schema additions', () => {
    prepareLegacyState(
      'model = "gpt-5"\napproval_policy = "never"\n',
      'model = "gpt-5"\napproval_policy = "on-request"\n'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('approval_policy = "never"')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('approval_policy = "on-request"')
    expect(readBaseline().conflicts).toEqual({
      approval_policy: { runtime: '"on-request"', system: '"never"' }
    })
  })

  it('lets an incompatible system TOML shape win instead of stranding a conflict', () => {
    prepareLegacyState(
      'model = "gpt-5"\ntui = { animations = false }\n',
      'model = "gpt-5"\n\n[tui]\ntheme = "runtime"\n'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toContain('tui = { animations = false }')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).not.toContain('theme = "runtime"')
    expect(readBaseline().conflicts).toBeUndefined()
    expect(readBaseline().settings['tui.theme']).toBeNull()
  })

  it('does not require filesystem timestamp mutation during migration', () => {
    prepareLegacyState(
      'model = "gpt-5"\n\n[tui]\ntheme = "system"\n',
      'model = "gpt-5"\n\n[tui]\ntheme = "runtime"\n'
    )
    const baselineBefore = readFileSync(baselinePath(), 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(existsSync(baselinePath())).toBe(true)
    expect(readFileSync(baselinePath(), 'utf-8')).not.toBe(baselineBefore)
    expect(readBaseline().conflicts?.['tui.theme']).toBeDefined()
  })
})
