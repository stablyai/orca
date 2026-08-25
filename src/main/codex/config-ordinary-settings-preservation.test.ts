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
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-ordinary-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-ordinary-user-data-'))
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

function setRuntimeConfig(content: string): void {
  mkdirSync(runtimeHomeDir(), { recursive: true })
  writeFileSync(runtimeConfigPath(), content, 'utf-8')
}

describe('ordinary Codex settings survive a managed-home remirror', () => {
  it('preserves top-level model and model_reasoning_effort written in the runtime home', () => {
    writeSystemConfig('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('model = "gpt-5.6-sol"')
    expect(readRuntimeConfig()).toContain('model_reasoning_effort = "max"')
    expect(readSystemConfig()).toContain('model = "gpt-5.6-sol"')
    expect(readSystemConfig()).toContain('model_reasoning_effort = "max"')
  })

  it('still promotes a runtime [tui] block into ~/.codex and keeps it after remirror', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark-photon"\nstatus_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('[tui]')
    expect(readSystemConfig()).toContain('theme = "dark-photon"')
    expect(readSystemConfig()).toContain('status_line = ["model"]')
    expect(readRuntimeConfig()).toContain('theme = "dark-photon"')
    expect(readRuntimeConfig()).toContain('status_line = ["model"]')
  })

  it('keeps Orca-rewritten path keys on the prepared system values, not stale runtime paths', () => {
    writeSystemConfig('model = "gpt-5"\nlog_dir = "logs"\n')
    syncSystemConfigIntoManagedCodexHome()

    const rewrittenLogDir = `log_dir = '${join(tmpHome, '.codex', 'logs')}'`
    expect(readRuntimeConfig()).toContain(rewrittenLogDir)

    setRuntimeConfig(`model = "gpt-5"\nlog_dir = "/stale/user/logs"\n`)
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain(rewrittenLogDir)
    expect(readRuntimeConfig()).not.toContain('/stale/user/logs')
    expect(readSystemConfig()).toContain('log_dir = "logs"')
    expect(readSystemConfig()).not.toContain('/stale/user/logs')
  })

  it('carries an unrelated user-set key through a remirror without writing it into ~/.codex', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\npersonality = "nerdy"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "nerdy"')
    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(existsSync(systemConfigPath())).toBe(true)
  })

  it('keeps a second runtime edit local instead of promoting an unlisted key', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\npersonality = "nerdy"\n')
    syncSystemConfigIntoManagedCodexHome()
    setRuntimeConfig('model = "gpt-5"\npersonality = "pragmatic"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "pragmatic"')
    expect(readSystemConfig()).not.toContain('personality')
  })

  it('mirrors a brand-new system ordinary key after an aligned snapshot', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    writeSystemConfig('model = "gpt-5"\npersonality = "nerdy"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "nerdy"')
    expect(readSystemConfig()).toContain('personality = "nerdy"')
  })

  it('carries an unlisted [tui] neighbor through a remirror', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\nanimations = false\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('animations = false')
    expect(readSystemConfig()).not.toContain('animations')
  })

  it('accepts a system-only change to an aligned unlisted key', () => {
    writeSystemConfig('model = "gpt-5"\npersonality = "nerdy"\n')
    syncSystemConfigIntoManagedCodexHome()

    writeSystemConfig('model = "gpt-5"\npersonality = "pragmatic"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "pragmatic"')
  })

  it('keeps a runtime deletion local until the system value changes', () => {
    writeSystemConfig('model = "gpt-5"\npersonality = "nerdy"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).not.toContain('personality')
    expect(readSystemConfig()).toContain('personality = "nerdy"')

    writeSystemConfig('model = "gpt-5"\npersonality = "pragmatic"\n')
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toContain('personality = "pragmatic"')
  })

  it('re-anchors an existing local conflict when the runtime value is deleted', () => {
    writeSystemConfig('model = "gpt-5"\npersonality = "system"\n')
    syncSystemConfigIntoManagedCodexHome()
    setRuntimeConfig('model = "gpt-5"\npersonality = "runtime"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('personality')
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8')).conflicts.personality).toEqual({
      runtime: null,
      system: '"system"'
    })
  })

  it('keeps simultaneous unlisted divergence local and content-anchored', () => {
    writeSystemConfig('model = "gpt-5"\npersonality = "ancestor"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\npersonality = "runtime"\n')
    writeSystemConfig('model = "gpt-5"\npersonality = "system"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "runtime"')
    expect(readSystemConfig()).toContain('personality = "system"')
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8')).conflicts.personality).toEqual({
      runtime: '"runtime"',
      system: '"system"'
    })
  })

  it('restores promoted values deleted from the runtime', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('[tui]\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('model = "gpt-5"')
    expect(readRuntimeConfig()).toContain('theme = "dark"')
    expect(readSystemConfig()).toContain('model = "gpt-5"')
    expect(readSystemConfig()).toContain('theme = "dark"')
  })

  it('keeps legacy-baseline unlisted edits local while promoted edits write through', () => {
    writeSystemConfig('model = "gpt-5"\npersonality = "system"\n')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(
      baselinePath(),
      `${JSON.stringify({ version: 2, settings: { model: '"gpt-5"' } })}\n`,
      'utf-8'
    )
    setRuntimeConfig('model = "o4"\npersonality = "runtime"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('model = "o4"')
    expect(readSystemConfig()).toContain('personality = "system"')
    expect(readRuntimeConfig()).toContain('personality = "runtime"')

    setRuntimeConfig('model = "o4"\npersonality = "runtime-2"\n')
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).not.toContain('personality = "runtime-2"')
    expect(readRuntimeConfig()).toContain('personality = "runtime-2"')
  })

  it('bootstraps missing source without treating unlisted runtime state as authoritative', () => {
    setRuntimeConfig('model = "seeded"\npersonality = "local"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8'))).toMatchObject({ version: 2 })
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8')).sourceAuthority).toBeUndefined()

    writeSystemConfig('model = "seeded"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "local"')
    expect(readSystemConfig()).not.toContain('personality')
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8'))).toMatchObject({
      version: 3,
      sourceAuthority: 'mirrored'
    })
  })

  it('stalls absent and blank sources after an authoritative mirror', () => {
    writeSystemConfig('model = "gpt-5"\npersonality = "system"\n')
    syncSystemConfigIntoManagedCodexHome()
    const baseline = readFileSync(baselinePath(), 'utf-8')
    setRuntimeConfig('model = "o4"\npersonality = "local"\n')

    rmSync(systemConfigPath())
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toContain('personality = "local"')
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(baseline)

    writeSystemConfig('   \n')
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toContain('model = "o4"')
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(baseline)

    writeSystemConfig('model = "gpt-5"\npersonality = "system"\n')
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toContain('model = "o4"')
    expect(readRuntimeConfig()).toContain('personality = "local"')
  })

  it('keeps supported unlisted values local when seeding a missing system config', () => {
    syncSystemConfigIntoManagedCodexHome()
    setRuntimeConfig(
      'model = "o4"\npersonality = "local"\n"quoted-local" = true\nmultiline = """\nvalue\n"""\n\n[features]\nhooks = true\n\n[mcp_servers.local]\ncommand = "run"\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('model = "o4"')
    expect(readSystemConfig()).not.toContain('personality')
    expect(readSystemConfig()).toContain('"quoted-local" = true')
    expect(readSystemConfig()).toContain('multiline = """')
    expect(readSystemConfig()).toContain('[features]')
    expect(readSystemConfig()).toContain('[mcp_servers.local]')
    expect(readRuntimeConfig()).toContain('personality = "local"')
  })

  it('excludes structured shapes and quoted unknown keys while preserving flat arrays', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    setRuntimeConfig(
      'model = "gpt-5"\ninline = { enabled = true }\nnested = [{ enabled = true }]\nflat = ["a", "b"]\n"quoted-local" = true\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('inline =')
    expect(readRuntimeConfig()).not.toContain('nested =')
    expect(readRuntimeConfig()).not.toContain('quoted-local')
    expect(readRuntimeConfig()).toContain('flat = ["a", "b"]')
    expect(readSystemConfig()).not.toContain('flat =')
  })

  it('lets table and dotted descendants win over colliding runtime scalars', () => {
    writeSystemConfig('model = "gpt-5"\nfoo.bar = true\n\n[tui.theme]\nvariant = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()
    setRuntimeConfig('model = "gpt-5"\nfoo = "scalar"\n\n[tui]\ntheme = "scalar"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('foo.bar = true')
    expect(readRuntimeConfig()).not.toContain('foo = "scalar"')
    expect(readRuntimeConfig()).toContain('[tui.theme]')
    expect(readRuntimeConfig()).not.toContain('theme = "scalar"')
  })
})
