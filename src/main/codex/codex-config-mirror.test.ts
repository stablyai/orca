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

import {
  prepareSystemConfigForFreshRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'

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

  it('preserves system-home relative path references in the runtime config copy', () => {
    writeFileSync(
      getSystemConfigPath(),
      [
        'model_instructions_file = "instructions.md"',
        "model_catalog_json = 'catalogs/models.json'",
        'experimental_compact_prompt_file = "prompts/compact.md"',
        'experimental_instructions_file = "legacy-instructions.md"',
        'log_dir = "logs"',
        'sqlite_home = "state"',
        '',
        '[agents.reviewer]',
        'config_file = "agents/reviewer.toml"',
        '',
        '[model_providers.qwen.auth]',
        'cwd = "auth"',
        '',
        '[[skills.config]]',
        'path = "skills/local"',
        ''
      ].join('\r\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain(
      `model_instructions_file = '${join(getSystemCodexHomePath(), 'instructions.md')}'`
    )
    expect(runtimeConfig).toContain(
      `model_catalog_json = '${join(getSystemCodexHomePath(), 'catalogs', 'models.json')}'`
    )
    expect(runtimeConfig).toContain(
      `experimental_compact_prompt_file = '${join(
        getSystemCodexHomePath(),
        'prompts',
        'compact.md'
      )}'`
    )
    expect(runtimeConfig).toContain(
      `experimental_instructions_file = '${join(
        getSystemCodexHomePath(),
        'legacy-instructions.md'
      )}'`
    )
    expect(runtimeConfig).toContain(`log_dir = '${join(getSystemCodexHomePath(), 'logs')}'`)
    expect(runtimeConfig).toContain(`sqlite_home = '${join(getSystemCodexHomePath(), 'state')}'`)
    expect(runtimeConfig).toContain(
      `config_file = '${join(getSystemCodexHomePath(), 'agents', 'reviewer.toml')}'`
    )
    expect(runtimeConfig).toContain(`cwd = '${join(getSystemCodexHomePath(), 'auth')}'`)
    expect(runtimeConfig).toContain(`path = '${join(getSystemCodexHomePath(), 'skills', 'local')}'`)
  })

  it('rewrites profile and debug lockfile path references', () => {
    writeFileSync(
      getSystemConfigPath(),
      [
        '[profiles.fast]',
        'model_catalog_json = "catalogs/fast.json"',
        '',
        '[debug.config_lockfile]',
        'load_path = "locks/config.lock.toml"',
        'export_dir = "locks"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain(
      `model_catalog_json = '${join(getSystemCodexHomePath(), 'catalogs', 'fast.json')}'`
    )
    expect(runtimeConfig).toContain(
      `load_path = '${join(getSystemCodexHomePath(), 'locks', 'config.lock.toml')}'`
    )
    expect(runtimeConfig).toContain(`export_dir = '${join(getSystemCodexHomePath(), 'locks')}'`)
  })

  it('does not treat lines inside multiline arrays as headers or path keys', () => {
    writeFileSync(
      getSystemConfigPath(),
      ['notify = [', '  ["custom", 1]', ']', 'log_dir = "logs"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('  ["custom", 1]')
    expect(runtimeConfig).toContain(`log_dir = '${join(getSystemCodexHomePath(), 'logs')}'`)
  })

  it('escapes control characters instead of emitting them raw in rewritten paths', () => {
    writeFileSync(getSystemConfigPath(), 'log_dir = "logs\\bdir"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('log_dir = "')
    expect(runtimeConfig).toContain('\\u0008')
    expect(runtimeConfig).not.toContain('\b')
  })

  it('leaves values with lone-surrogate unicode escapes untouched', () => {
    writeFileSync(getSystemConfigPath(), 'log_dir = "logs\\uD800dir"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('log_dir = "logs\\uD800dir"')
  })

  it('leaves absolute, home-prefixed, env-shaped, and URL path references untouched', () => {
    const passthroughLines = [
      'model_instructions_file = "~/notes/instructions.md"',
      'model_catalog_json = "$CODEX_ASSETS/models.json"',
      'experimental_instructions_file = "%USERPROFILE%\\\\instructions.md"',
      'log_dir = "/var/log/codex"',
      "sqlite_home = 'C:\\Users\\example\\state'",
      'experimental_compact_prompt_file = "file://server/prompts/compact.md"'
    ]
    writeFileSync(getSystemConfigPath(), `${passthroughLines.join('\n')}\n`, 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    for (const line of passthroughLines) {
      expect(runtimeConfig).toContain(line)
    }
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

  it('deduplicates basic and literal project headers by decoded Windows path', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ["[projects.'c:\\gemini_etl']", 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['[projects."c:\\\\gemini_etl"]', 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain("[projects.'c:\\gemini_etl']")
  })

  it('deduplicates a CRLF system project header against an LF runtime header', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    const projectHeader = '[projects."C:/Users/jinwo/orca/workspaces/orca/repo"]'
    writeFileSync(
      getRuntimeConfigPath(),
      [projectHeader, 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [projectHeader, 'trust_level = "trusted"', ''].join('\r\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain(`${projectHeader}\ntrust_level = "trusted"`)
  })

  it('self-heals duplicate project tables in a CRLF runtime config', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    const projectHeader = '[projects."C:/Users/jinwo/orca/workspaces/orca/repo"]'
    writeFileSync(
      getRuntimeConfigPath(),
      [
        projectHeader,
        'trust_level = "trusted"',
        '',
        projectHeader,
        'trust_level = "trusted"',
        ''
      ].join('\r\n'),
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), 'model = "gpt-5"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain('trust_level = "trusted"')
  })

  it('applies a CRLF system revocation to an LF runtime project', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ["[projects.'c:\\repo']", 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['[projects."C:/repo"]', 'trust_level = "untrusted"', ''].join('\r\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).not.toContain('trust_level = "trusted"')
  })

  it('lets a semantically matching system revocation replace runtime trust', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ["[projects.'c:\\gemini_etl']", 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['[projects."C:/gemini_etl"]', 'trust_level = "untrusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain('[projects."C:/gemini_etl"]')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).not.toContain('trust_level = "trusted"')
  })

  it('applies a case-drifted WSL system revocation to the runtime trusted block', () => {
    // Why: configs written before WSL tails compared case-sensitively can hold
    // the revocation under drifted casing; err toward revoked, not trusted.
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ["[projects.'\\\\wsl$\\Ubuntu\\home\\u\\Repo']", 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ["[projects.'\\\\wsl$\\Ubuntu\\home\\u\\repo']", 'trust_level = "untrusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).not.toContain('trust_level = "trusted"')
  })

  it('keeps runtime trust when the system config re-trusts the exact-cased WSL project', () => {
    // Why: after a user re-grants trust, markCodexProjectTrusted appends an
    // exact-cased trusted block beside a legacy drifted-case revocation; the
    // loose revocation match must not revert that grant on every mirror pass.
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ["[projects.'\\\\wsl$\\Ubuntu\\home\\u\\Repo']", 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [
        "[projects.'\\\\wsl$\\Ubuntu\\home\\u\\repo']",
        'trust_level = "untrusted"',
        '',
        "[projects.'\\\\wsl$\\Ubuntu\\home\\u\\Repo']",
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain("[projects.'\\\\wsl$\\Ubuntu\\home\\u\\Repo']")
    expect(runtimeConfig).toContain('trust_level = "trusted"')
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
  })

  it('does not let a case-distinct POSIX system revocation clobber runtime trust', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      ['[projects."/home/u/Repo"]', 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      ['[projects."/home/u/repo"]', 'trust_level = "untrusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(2)
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).toContain('trust_level = "trusted"')
  })

  it.each([
    {
      name: 'drive-letter casing and separators',
      runtimePath: 'c:\\work\\repo',
      systemPath: 'C:/work/repo'
    },
    {
      name: 'WSL UNC path',
      runtimePath: '\\\\wsl$\\Ubuntu\\home\\u\\proj',
      systemPath: '//WSL$/ubuntu/home/u/proj'
    },
    {
      name: 'server UNC path',
      runtimePath: '\\\\server\\share\\proj',
      systemPath: '//SERVER/share/proj'
    }
  ])('deduplicates $name across mirror inputs', ({ runtimePath, systemPath }) => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [`[projects.'${runtimePath}']`, 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [`[projects."${systemPath}"]`, 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8').match(/\[projects\./g)).toHaveLength(1)
  })

  it('self-heals duplicate project tables already present in the runtime config', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        '[projects."c:\\\\gemini_etl"]',
        'trust_level = "trusted"',
        '',
        "[projects.'c:\\gemini_etl']",
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), 'model = "gpt-5"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain('[projects."c:\\\\gemini_etl"]')
  })

  it('keeps untrusted when self-healing duplicate project tables', () => {
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        '[projects."c:\\\\gemini_etl"]',
        'trust_level = "trusted"',
        '',
        "[projects.'C:\\gemini_etl']",
        'trust_level = "untrusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    writeFileSync(getSystemConfigPath(), 'model = "gpt-5"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).not.toContain('trust_level = "trusted"')
  })

  it('keeps untrusted when self-healing duplicate system project tables', () => {
    writeFileSync(
      getSystemConfigPath(),
      [
        '[projects."c:\\\\gemini_etl"]',
        'trust_level = "trusted"',
        '',
        "[projects.'C:\\gemini_etl']",
        'trust_level = "untrusted"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig.match(/\[projects\./g)).toHaveLength(1)
    expect(runtimeConfig).toContain('trust_level = "untrusted"')
    expect(runtimeConfig).not.toContain('trust_level = "trusted"')
  })

  it('deduplicates a POSIX project path containing a quote and backslash', () => {
    const projectPath = '/tmp/with"quote\\and-backslash'
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [`[projects.'${projectPath}']`, 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )
    writeFileSync(
      getSystemConfigPath(),
      [`[projects."/tmp/with\\"quote\\\\and-backslash"]`, 'trust_level = "trusted"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8').match(/\[projects\./g)).toHaveLength(1)
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

describe('prepareSystemConfigForFreshRuntimeMirror', () => {
  it('uses the Linux-side directory for WSL UNC source homes', () => {
    const sourceDir = resolveCodexConfigMirrorSourceDirectory(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
    )

    expect(sourceDir).toBe('/home/alice/.codex')
    expect(
      prepareSystemConfigForFreshRuntimeMirror(
        'model_instructions_file = "instructions.md"\n',
        sourceDir
      )
    ).toContain("model_instructions_file = '/home/alice/.codex/instructions.md'")
  })

  it('rewrites relative paths against a Linux-side home and strips hook trust', () => {
    const prepared = prepareSystemConfigForFreshRuntimeMirror(
      [
        'model_instructions_file = "instructions.md"',
        '',
        '[features]',
        'codex_hooks = true',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        '',
        '[projects."/home/alice/repo"]',
        'trust_level = "trusted"',
        ''
      ].join('\r\n'),
      '/home/alice/.codex'
    )

    // Why: WSL configs are consumed inside the distro, so rewrites must use
    // posix join semantics regardless of the host platform.
    expect(prepared).toContain("model_instructions_file = '/home/alice/.codex/instructions.md'")
    expect(prepared).toContain('hooks = true')
    expect(prepared).not.toContain('codex_hooks')
    expect(prepared).toContain('[projects."/home/alice/repo"]')
    expect(prepared).not.toContain('[hooks.state."system-hooks:stop:0:0"]')
  })
})
