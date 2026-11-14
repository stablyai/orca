import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

// Why: temp homes exceed sun_path on macOS but not on Linux; keep asserted config bytes host-independent.
vi.mock('../shared-server/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

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
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'
import '../../trust/toml/config-toml-trust'

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
  it('pins a keyring credential store to file in the managed home and leaves ~/.codex unchanged', () => {
    writeFileSync(
      getSystemConfigPath(),
      'model = "system-model"\ncli_auth_credentials_store = "keyring"\n',
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).toContain('cli_auth_credentials_store = "file" # orca:')
    expect(runtimeConfig).not.toContain('"keyring"')
    expect(readFileSync(getSystemConfigPath(), 'utf-8')).toBe(
      'model = "system-model"\ncli_auth_credentials_store = "keyring"\n'
    )
  })

  it('preserves an existing runtime config when the system config is blank', () => {
    // A zero-byte cloud-synced config may be half-written or unhydrated.
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    const runtimeConfig = ['model = "runtime-model"', '', '[features]', 'hooks = true', ''].join(
      '\n'
    )
    writeFileSync(getRuntimeConfigPath(), runtimeConfig, 'utf-8')
    writeFileSync(getSystemConfigPath(), '', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe(runtimeConfig)
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

  it('applies a case-drifted WSL system revocation to the runtime trusted block', () => {
    // Legacy WSL configs can hold revocations under drifted casing.
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
})

describe('syncSystemConfigIntoLegacySharedCodexHome', () => {
  it('recovers an interrupted runtime config when the system source is missing', () => {
    const runtimeConfigPath = getRuntimeConfigPath()
    const heldConfigPath = `${runtimeConfigPath}.orca-guarded`
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(heldConfigPath, 'model = "retained"\n', 'utf-8')

    syncSystemConfigIntoLegacySharedCodexHome({
      runtimeHomePath: join(userDataDir, 'codex-runtime-home', 'home'),
      systemHomePath: getSystemCodexHomePath()
    })

    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "retained"\n')
    expect(existsSync(heldConfigPath)).toBe(false)
  })
})
