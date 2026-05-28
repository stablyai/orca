import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemCodexHomePath(): string {
  return join(fakeHomeDir, '.codex')
}

function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

function getRuntimeConfigPath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('syncSystemConfigIntoManagedCodexHome', () => {
  it('seeds a missing runtime config without copying system hook trust', () => {
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
  })

  it('normalizes deprecated codex_hooks feature flag only in runtime config', () => {
    writeFileSync(
      getSystemConfigPath(),
      ['model = "system-model"', '', '[features]', 'codex_hooks = true', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[features]\nhooks = true')
    expect(runtimeConfig).not.toContain('codex_hooks')
    expect(readFileSync(getSystemConfigPath(), 'utf-8')).toContain('codex_hooks = true')
  })

  it('drops deprecated codex_hooks when the new hooks flag already exists', () => {
    writeFileSync(
      getSystemConfigPath(),
      ['[features]', 'hooks = true', 'codex_hooks = true', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[features]\nhooks = true')
    expect(runtimeConfig).not.toContain('codex_hooks')
  })

  it('mirrors system config updates while preserving runtime-owned trust sections', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "runtime-model"',
        '',
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = false',
        'trusted_hash = "sha256:runtime"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        '',
        '[projects."/runtime-only"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        'model = "system-model"',
        '',
        '[projects."/repo"] # explicit revocation',
        'trust_level = "untrusted"',
        '',
        '[projects."/system-only"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).not.toContain('model = "runtime-model"')
    expect(runtimeConfig).toContain('[projects."/repo"]')
    expect(runtimeConfig).toContain('[projects."/runtime-only"]')
    expect(runtimeConfig).toContain('[projects."/system-only"]')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig.match(/\[projects\."\/repo"\]/g)?.length).toBe(1)
  })

  it('does not treat TOML table headers inside multiline strings as sections', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        'instructions = """',
        '[hooks.state."inside-basic-string"]',
        'trusted_hash = "not-a-section"',
        '"""',
        '',
        "literal_instructions = '''",
        '[hooks.state."inside-literal-string"]',
        "'''",
        '',
        '[model_providers.openai]',
        'name = "OpenAI"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('[hooks.state."inside-basic-string"]')
    expect(runtimeConfig).toContain('[hooks.state."inside-literal-string"]')
    expect(runtimeConfig).toContain('[model_providers.openai]')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
  })

  it('does not let triple quotes in comments affect runtime-owned section mirroring', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        '# example: """ in a comment',
        "# example: ''' in a comment",
        'model = "runtime-model"',
        '',
        '[hooks.state."runtime-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        '# system example: """ in a comment',
        "# system example: ''' in a comment",
        'model = "system-model"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:system"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).toContain('[hooks.state."runtime-hooks:stop:0:0"]')
    expect(runtimeConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(runtimeConfig).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
    expect(runtimeConfig).not.toContain('trusted_hash = "sha256:system"')
  })

  it('does not create a runtime config when neither system nor runtime config exists', () => {
    syncSystemConfigIntoManagedCodexHome()

    expect(existsSync(getRuntimeConfigPath())).toBe(false)
  })
})
