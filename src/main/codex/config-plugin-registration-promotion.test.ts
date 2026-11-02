import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as CodexFsUtils from '../codex-accounts/fs-utils'

const { homedirMock, registrationTestState } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  registrationTestState: { failAtomicWrite: false }
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
      if (registrationTestState.failAtomicWrite) {
        throw new Error('injected atomic write failure')
      }
      return actual.writeFileAtomically(...args)
    }
  }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { getCodexRegistrationKey } from './config-toml-plugin-registration-tables'

// Registration tables written by Codex 0.145 marketplace and plugin additions.
const MARKETPLACE_TABLE = [
  '[marketplaces.ponytail]',
  'source_type = "git"',
  'source = "https://github.com/DietrichGebert/ponytail.git"',
  'ref_name = "main"',
  'last_updated = "2026-01-05T10:00:00Z"',
  'last_revision = "aaaa111"'
].join('\n')

const PLUGIN_TABLE = ['[plugins."ponytail@ponytail"]', 'enabled = true', 'version = "4.8.4"'].join(
  '\n'
)

const MARKETPLACE_KEY = getCodexRegistrationKey('marketplaces', 'ponytail')
const PLUGIN_KEY = getCodexRegistrationKey('plugins', 'ponytail@ponytail')

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-registration-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-registration-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  registrationTestState.failAtomicWrite = false
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

function systemHomeDir(): string {
  return join(tmpHome, '.codex')
}

function runtimeHomeDir(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function runtimeConfigPath(): string {
  return join(runtimeHomeDir(), 'config.toml')
}

function baselinePath(homePath = runtimeHomeDir()): string {
  return join(homePath, '.orca-config-settings-baseline.json')
}

function writeSystemConfig(content: string, homePath = systemHomeDir()): void {
  mkdirSync(homePath, { recursive: true })
  writeFileSync(join(homePath, 'config.toml'), content, 'utf-8')
}

function readSystemConfig(homePath = systemHomeDir()): string {
  return readFileSync(join(homePath, 'config.toml'), 'utf-8')
}

function readRuntimeConfig(homePath = runtimeHomeDir()): string {
  return readFileSync(join(homePath, 'config.toml'), 'utf-8')
}

function simulateCodexRegistrationWrite(block: string, homePath = runtimeHomeDir()): void {
  mkdirSync(homePath, { recursive: true })
  const configPath = join(homePath, 'config.toml')
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  writeFileSync(configPath, `${existing.trimEnd()}\n\n${block}\n`, 'utf-8')
}

function simulateCodexRegistrationFieldWrite(
  field: string,
  rawValue: string,
  homePath = runtimeHomeDir()
): void {
  const configPath = join(homePath, 'config.toml')
  const pattern = new RegExp(`^${field}[ \\t]*=.*$`, 'm')
  const existing = readFileSync(configPath, 'utf-8')
  writeFileSync(configPath, existing.replace(pattern, `${field} = ${rawValue}`), 'utf-8')
}

function mirrorTwice(): void {
  syncSystemConfigIntoManagedCodexHome()
  syncSystemConfigIntoManagedCodexHome()
}

describe('codex plugin registration survives the managed-home mirror', () => {
  it('promotes a runtime-only marketplace that a metadata-only policy would drop', () => {
    writeSystemConfig('model = "gpt-5"\n\n[marketplaces.other]\nsource = "other"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    mirrorTwice()

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.other]')
  })

  it('honors a canonical removal instead of resurrecting the registration', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(`${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}`)
    mirrorTwice()
    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')

    writeSystemConfig('model = "gpt-5"\n')
    mirrorTwice()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).not.toContain('marketplaces.ponytail')
    expect(readRuntimeConfig()).not.toContain('ponytail@ponytail')
  })

  it('re-mirrors a canonical registration the managed home deleted rather than propagating the delete', () => {
    writeSystemConfig(`model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}\n`)
    syncSystemConfigIntoManagedCodexHome()

    writeFileSync(runtimeConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    mirrorTwice()

    expect(readSystemConfig()).toContain('[plugins."ponytail@ponytail"]')
    expect(readRuntimeConfig()).toContain('[plugins."ponytail@ponytail"]')
  })

  it('promotes an in-Codex plugin disable and keeps it disabled', () => {
    writeSystemConfig(`model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}\n`)
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationFieldWrite('enabled', 'false')
    mirrorTwice()

    expect(readSystemConfig()).toContain('enabled = false')
    expect(readRuntimeConfig()).toContain('enabled = false')
  })

  // Include absence as the third enabled state so both sides can diverge.
  it('lets the canonical config win when enablement changed to a different value on each side', () => {
    writeSystemConfig(
      `model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE.replace('enabled = true\n', '')}\n`
    )
    syncSystemConfigIntoManagedCodexHome()
    expect(readFileSync(baselinePath(), 'utf-8')).not.toContain('"enabled"')

    writeFileSync(
      runtimeConfigPath(),
      readRuntimeConfig().replace('version = "4.8.4"', 'version = "4.8.4"\nenabled = false'),
      'utf-8'
    )
    writeSystemConfig(
      readSystemConfig().replace('version = "4.8.4"', 'version = "4.8.4"\nenabled = true')
    )
    mirrorTwice()

    expect(readSystemConfig()).toContain('enabled = true')
    expect(readSystemConfig()).not.toContain('enabled = false')
    expect(readRuntimeConfig()).toContain('enabled = true')
  })

  it('lets the canonical config win when the registration has no mirrored ancestor', () => {
    writeSystemConfig(`model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}\n`)
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationFieldWrite('enabled', 'false')
    // v2 and rebuilt baselines have no registration history.
    const baseline = JSON.parse(readFileSync(baselinePath(), 'utf-8'))
    delete baseline.registrations
    writeFileSync(baselinePath(), `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8')
    mirrorTwice()

    expect(readSystemConfig()).toContain('enabled = true')
    expect(readRuntimeConfig()).toContain('enabled = true')
  })

  it('keeps an unrelated canonical edit authoritative while a registration is promoted', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    writeSystemConfig('model = "gpt-5-canonical"\n\n[features]\nhooks = true\n')
    mirrorTwice()

    expect(readRuntimeConfig()).toContain('model = "gpt-5-canonical"')
    expect(readRuntimeConfig()).toContain('hooks = true')
    expect(readRuntimeConfig()).toContain('[marketplaces.ponytail]')
  })
})

describe('codex marketplace refresh metadata promotion', () => {
  function seedMirroredMarketplace(): void {
    writeSystemConfig(
      `# user comment\nmodel = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n[mcp_servers.docs]\ncommand = "docs"\n`
    )
    syncSystemConfigIntoManagedCodexHome()
  }

  it('promotes a newer last_updated with its paired last_revision', () => {
    seedMirroredMarketplace()

    simulateCodexRegistrationFieldWrite('last_updated', '"2026-02-01T09:30:00Z"')
    simulateCodexRegistrationFieldWrite('last_revision', '"bbbb222"')
    syncSystemConfigIntoManagedCodexHome()

    const system = readSystemConfig()
    expect(system).toContain('last_updated = "2026-02-01T09:30:00Z"')
    expect(system).toContain('last_revision = "bbbb222"')
    expect(system).toContain('# user comment')
    expect(system).toContain('ref_name = "main"')
    expect(system).toContain('[mcp_servers.docs]')
    expect(system).toContain('source = "https://github.com/DietrichGebert/ponytail.git"')
  })

  it('skips an older managed timestamp', () => {
    seedMirroredMarketplace()

    simulateCodexRegistrationFieldWrite('last_updated', '"2020-01-01T00:00:00Z"')
    simulateCodexRegistrationFieldWrite('last_revision', '"stale99"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('last_updated = "2026-01-05T10:00:00Z"')
    expect(readSystemConfig()).toContain('last_revision = "aaaa111"')
  })

  // Date.parse rolls impossible dates forward, potentially making them look newer.
  it('rejects an impossible calendar date instead of rolling it forward', () => {
    seedMirroredMarketplace()

    simulateCodexRegistrationFieldWrite('last_updated', '"2026-02-30T00:00:00Z"')
    simulateCodexRegistrationFieldWrite('last_revision', '"rolled99"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('last_updated = "2026-01-05T10:00:00Z"')
    expect(readSystemConfig()).toContain('last_revision = "aaaa111"')
  })

  it('skips the refresh when the runtime cannot supply the paired last_revision', () => {
    seedMirroredMarketplace()

    writeFileSync(
      runtimeConfigPath(),
      readRuntimeConfig()
        .replace('last_updated = "2026-01-05T10:00:00Z"', 'last_updated = "2026-09-01T00:00:00Z"')
        .replace('last_revision = "aaaa111"\n', ''),
      'utf-8'
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('last_updated = "2026-01-05T10:00:00Z"')
    expect(readSystemConfig()).toContain('last_revision = "aaaa111"')
  })

  it('leaves the canonical config in control when the marketplace source changed', () => {
    seedMirroredMarketplace()

    simulateCodexRegistrationFieldWrite('last_updated', '"2026-02-01T09:30:00Z"')
    simulateCodexRegistrationFieldWrite('last_revision', '"bbbb222"')
    writeSystemConfig(
      readSystemConfig().replace(
        'source = "https://github.com/DietrichGebert/ponytail.git"',
        'source = "https://github.com/DietrichGebert/ponytail-fork.git"'
      )
    )
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('last_updated = "2026-01-05T10:00:00Z"')
    expect(readSystemConfig()).toContain('ponytail-fork.git')
    expect(readRuntimeConfig()).toContain('ponytail-fork.git')
  })

  it('promotes only last_updated and last_revision, never another refreshed field', () => {
    writeSystemConfig(`model = "gpt-5"\n\n${MARKETPLACE_TABLE}\ndescription = "canonical"\n`)
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationFieldWrite('last_updated', '"2026-02-01T09:30:00Z"')
    simulateCodexRegistrationFieldWrite('description', '"runtime"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('last_updated = "2026-02-01T09:30:00Z"')
    expect(readSystemConfig()).toContain('description = "canonical"')
    expect(readRuntimeConfig()).toContain('description = "canonical"')
  })

  it('seeds an absent canonical config from the runtime without duplicating its tables', () => {
    writeSystemConfig('[features]\nhooks = true\n')
    syncSystemConfigIntoManagedCodexHome()

    rmSync(join(systemHomeDir(), 'config.toml'))
    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    writeFileSync(runtimeConfigPath(), `model = "o4"\n${readRuntimeConfig()}`, 'utf-8')
    mirrorTwice()

    const system = readSystemConfig()
    expect(system).toContain('model = "o4"')
    expect(system.match(/\[marketplaces\.ponytail\]/g)).toHaveLength(1)
    expect(readRuntimeConfig().match(/\[marketplaces\.ponytail\]/g)).toHaveLength(1)
  })

  it('preserves the managed config and its baseline when the promotion write fails', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    const runtimeBeforeFailure = readRuntimeConfig()
    const baselineBeforeFailure = readFileSync(baselinePath(), 'utf-8')

    registrationTestState.failAtomicWrite = true
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).toBe(runtimeBeforeFailure)
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(baselineBeforeFailure)

    registrationTestState.failAtomicWrite = false
    mirrorTwice()

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.ponytail]')
  })
})

describe('codex registration reconciliation isolates accounts and source homes', () => {
  function accountHome(name: string): string {
    return join(userDataDir, 'codex-accounts', name)
  }

  it('promotes each managed account registration into the shared source without crossing baselines', () => {
    writeSystemConfig('model = "gpt-5"\n')
    const accounts = [accountHome('a'), accountHome('b')]
    for (const runtimeHomePath of accounts) {
      syncSystemConfigIntoManagedCodexHome({
        runtimeHomePath,
        systemHomePath: systemHomeDir()
      })
    }

    simulateCodexRegistrationWrite(MARKETPLACE_TABLE, accounts[0]!)
    simulateCodexRegistrationWrite(
      '[marketplaces.beta]\nsource_type = "git"\nsource = "https://example.test/beta.git"',
      accounts[1]!
    )
    for (const runtimeHomePath of [...accounts, ...accounts]) {
      syncSystemConfigIntoManagedCodexHome({
        runtimeHomePath,
        systemHomePath: systemHomeDir()
      })
    }

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readSystemConfig()).toContain('[marketplaces.beta]')
    for (const runtimeHomePath of accounts) {
      expect(readRuntimeConfig(runtimeHomePath)).toContain('[marketplaces.ponytail]')
      expect(readRuntimeConfig(runtimeHomePath)).toContain('[marketplaces.beta]')
      expect(existsSync(baselinePath(runtimeHomePath))).toBe(true)
    }
    expect(readFileSync(baselinePath(accounts[0]!), 'utf-8')).toContain('marketplaces:ponytail')
  })

  it('promotes a WSL-lane registration into that distro source home, never the host one', () => {
    const wslSourceHome = join(userDataDir, 'wsl-home', '.codex')
    const wslRuntimeHome = accountHome('wsl')
    writeSystemConfig('model = "host"\n')
    writeSystemConfig('model = "wsl"\n', wslSourceHome)
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: wslRuntimeHome,
      systemHomePath: wslSourceHome
    })

    simulateCodexRegistrationWrite(MARKETPLACE_TABLE, wslRuntimeHome)
    for (let pass = 0; pass < 2; pass += 1) {
      syncSystemConfigIntoManagedCodexHome({
        runtimeHomePath: wslRuntimeHome,
        systemHomePath: wslSourceHome
      })
    }

    expect(readSystemConfig(wslSourceHome)).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig(wslRuntimeHome)).toContain('[marketplaces.ponytail]')
    expect(readSystemConfig()).toBe('model = "host"\n')
  })

  it('heals a registration held only by a runtime home still on the v2 baseline schema', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    const { settings } = JSON.parse(readFileSync(baselinePath(), 'utf-8'))
    writeFileSync(baselinePath(), `${JSON.stringify({ version: 2, settings }, null, 2)}\n`, 'utf-8')

    simulateCodexRegistrationWrite(`${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}`)
    mirrorTwice()

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readSystemConfig()).toContain('[plugins."ponytail@ponytail"]')
    expect(readRuntimeConfig()).toContain('[plugins."ponytail@ponytail"]')
    expect(JSON.parse(readFileSync(baselinePath(), 'utf-8'))).toMatchObject({
      version: 3,
      registrations: { [MARKETPLACE_KEY]: {}, [PLUGIN_KEY]: { enabled: 'true' } }
    })
  })

  it('leaves a settled config byte-identical when the baseline is lost with no removal pending', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    mirrorTwice()
    const settledSystem = readSystemConfig()
    const settledRuntime = readRuntimeConfig()

    rmSync(baselinePath())
    mirrorTwice()

    expect(readSystemConfig()).toBe(settledSystem)
    expect(readRuntimeConfig()).toBe(settledRuntime)
  })

  it('treats a runtime home seeded without a baseline as holding additions, not removals', () => {
    mkdirSync(runtimeHomeDir(), { recursive: true })
    writeFileSync(runtimeConfigPath(), `model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n`, 'utf-8')
    writeSystemConfig('model = "gpt-5"\n')

    mirrorTwice()

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.ponytail]')
  })
})
