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
import {
  getCodexRegistrationKey,
  readCodexRegistrationEntries
} from './config-toml-plugin-registration-tables'

// The tables Codex 0.145 writes into CODEX_HOME for `plugin marketplace add`
// followed by `plugin add`, including the quoted `<plugin>@<marketplace>` key.
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

/** Mimics Codex appending a registration table to the CODEX_HOME it was launched with. */
function simulateCodexRegistrationWrite(block: string, homePath = runtimeHomeDir()): void {
  mkdirSync(homePath, { recursive: true })
  const configPath = join(homePath, 'config.toml')
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  writeFileSync(configPath, `${existing.trimEnd()}\n\n${block}\n`, 'utf-8')
}

/** Mimics Codex rewriting a value inside a registration table it already owns. */
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
  it('keeps a marketplace and a quoted plugin registered from the managed home across two mirrors', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationWrite(`${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}`)
    mirrorTwice()

    const runtime = readRuntimeConfig()
    expect(runtime).toContain('[marketplaces.ponytail]')
    expect(runtime).toContain('[plugins."ponytail@ponytail"]')
    expect(runtime).toContain('enabled = true')
    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readSystemConfig()).toContain('[plugins."ponytail@ponytail"]')
  })

  it('reaches a byte-stable steady state, so a repeated mirror is a no-op', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(`${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}`)
    mirrorTwice()

    const settledRuntime = readRuntimeConfig()
    const settledSystem = readSystemConfig()
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toBe(settledRuntime)
    expect(readSystemConfig()).toBe(settledSystem)
  })

  // Why: #11770's metadata-only policy deliberately skips runtime-only
  // marketplaces, so it would drop this one even though its timestamps are fine.
  it('promotes a runtime-only marketplace that a metadata-only policy would drop', () => {
    writeSystemConfig('model = "gpt-5"\n\n[marketplaces.other]\nsource = "other"\n')
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    mirrorTwice()

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.other]')
  })

  it('does not treat a cached marketplace clone or plugin directory as a registration', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    mkdirSync(join(runtimeHomeDir(), '.tmp', 'marketplaces', 'ponytail'), {
      recursive: true
    })
    mkdirSync(join(runtimeHomeDir(), 'plugins', 'ponytail'), {
      recursive: true
    })

    mirrorTwice()

    expect(readSystemConfig()).not.toContain('marketplaces')
    expect(readRuntimeConfig()).not.toContain('marketplaces')
  })

  it('honors a canonical removal instead of resurrecting the registration', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(`${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}`)
    mirrorTwice()
    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')

    // The user edits ~/.codex outside Orca and deletes both registrations.
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

  it('lets the canonical config win when both sides changed plugin enablement', () => {
    writeSystemConfig(`model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}\n`)
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationFieldWrite('enabled', 'false')
    writeSystemConfig(
      `model = "gpt-5"\n\n${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE.replace('enabled = true', 'enabled = false\ndisabled_reason = "canonical"')}\n`
    )
    mirrorTwice()

    expect(readSystemConfig()).toContain('disabled_reason = "canonical"')
    expect(readRuntimeConfig()).toContain('disabled_reason = "canonical"')
  })

  // Why: `enabled` is three-valued in practice — true, false, and absent — so
  // "both sides changed" is only reachable when one of them adds the key.
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
    // A v2 baseline, or one rebuilt after corruption, tracks no registration at all.
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
    // Every other field, the comment, and unrelated tables are untouched.
    expect(system).toContain('# user comment')
    expect(system).toContain('ref_name = "main"')
    expect(system).toContain('[mcp_servers.docs]')
    expect(system).toContain('source = "https://github.com/DietrichGebert/ponytail.git"')
  })

  it('does not repeat the refresh on the next synchronization', () => {
    seedMirroredMarketplace()
    simulateCodexRegistrationFieldWrite('last_updated', '"2026-02-01T09:30:00Z"')
    simulateCodexRegistrationFieldWrite('last_revision', '"bbbb222"')
    mirrorTwice()

    const settledSystem = readSystemConfig()
    const settledRuntime = readRuntimeConfig()
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(settledSystem)
    expect(readRuntimeConfig()).toBe(settledRuntime)
  })

  it('skips an older managed timestamp', () => {
    seedMirroredMarketplace()

    simulateCodexRegistrationFieldWrite('last_updated', '"2020-01-01T00:00:00Z"')
    simulateCodexRegistrationFieldWrite('last_revision', '"stale99"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('last_updated = "2026-01-05T10:00:00Z"')
    expect(readSystemConfig()).toContain('last_revision = "aaaa111"')
  })

  it('skips a malformed managed timestamp', () => {
    seedMirroredMarketplace()

    simulateCodexRegistrationFieldWrite('last_updated', '"not-a-timestamp"')
    simulateCodexRegistrationFieldWrite('last_revision', '"cccc333"')
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

  it('refreshes several marketplaces independently', () => {
    writeSystemConfig(
      [
        'model = "gpt-5"',
        '',
        MARKETPLACE_TABLE,
        '',
        '[marketplaces.other]',
        'source_type = "git"',
        'source = "https://example.test/other.git"',
        'last_updated = "2026-01-05T10:00:00Z"',
        'last_revision = "other111"',
        ''
      ].join('\n')
    )
    syncSystemConfigIntoManagedCodexHome()

    const runtime = readRuntimeConfig()
      .replace('last_updated = "2026-01-05T10:00:00Z"', 'last_updated = "2026-03-01T00:00:00Z"')
      .replace('last_revision = "aaaa111"', 'last_revision = "fresh11"')
    writeFileSync(runtimeConfigPath(), runtime, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    const system = readSystemConfig()
    expect(system).toContain('last_updated = "2026-03-01T00:00:00Z"')
    expect(system).toContain('last_revision = "fresh11"')
    expect(system).toContain('last_revision = "other111"')
    expect(system).toContain('last_updated = "2026-01-05T10:00:00Z"')
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

  it('keeps CRLF line endings when it rewrites refresh metadata', () => {
    writeSystemConfig(`model = "gpt-5"\r\n\r\n${MARKETPLACE_TABLE.replaceAll('\n', '\r\n')}\r\n`)
    syncSystemConfigIntoManagedCodexHome()

    simulateCodexRegistrationFieldWrite('last_updated', '"2026-02-01T09:30:00Z"')
    syncSystemConfigIntoManagedCodexHome()

    const system = readSystemConfig()
    expect(system).toContain('last_updated = "2026-02-01T09:30:00Z"\r\n')
    expect(system).not.toMatch(/[^\r]\n/)
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

  // Why: the baseline is the only record of what a mirror already made canonical,
  // so losing it re-reads a pending canonical removal as a runtime-only addition.
  it('re-promotes a canonically removed registration when the baseline is lost first', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    mirrorTwice()

    writeSystemConfig('model = "gpt-5"\n')
    rmSync(baselinePath())
    mirrorTwice()
    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')

    // Recoverable: with the rebuilt baseline in place, removing it again sticks.
    writeSystemConfig('model = "gpt-5"\n')
    mirrorTwice()
    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
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

describe('codex registration table identity', () => {
  it('reads basic-quoted and literal-quoted table keys as the same registration', () => {
    const basic = readCodexRegistrationEntries('[plugins."a@b"]\nenabled = true\n')
    const literal = readCodexRegistrationEntries("[plugins.'a@b']\nenabled = false\n")

    expect([...basic.keys()]).toEqual([getCodexRegistrationKey('plugins', 'a@b')])
    expect([...literal.keys()]).toEqual([...basic.keys()])
  })

  it('captures a multiline array field as one value and marks it unwritable', () => {
    const entries = readCodexRegistrationEntries(
      '[marketplaces.m]\nsparse_paths = [\n  "a",\n  "b"\n]\nsource = "s"\n'
    )
    const entry = entries.get(getCodexRegistrationKey('marketplaces', 'm'))

    expect(entry?.fields.get('sparse_paths')?.multiline).toBe(true)
    expect(entry?.fields.get('sparse_paths')?.raw).toContain('"b"')
    expect(entry?.fields.get('source')?.raw).toBe('"s"')
  })

  it('attributes a subtable to its owning registration', () => {
    const entries = readCodexRegistrationEntries(
      '[marketplaces.m]\nsource = "s"\n\n[marketplaces.m.auth]\ntoken = "t"\n'
    )
    const entry = entries.get(getCodexRegistrationKey('marketplaces', 'm'))

    expect(entries.size).toBe(1)
    expect(entry?.block).toContain('[marketplaces.m.auth]')
    expect(entry?.fields.has('token')).toBe(false)
  })

  it("leaves the next table's leading comment out of the captured block", () => {
    const entries = readCodexRegistrationEntries(
      '[marketplaces.m]\nsource = "s" # inline\n# keeps this one\nkey = 1\n\n# belongs to mcp_servers\n[mcp_servers.docs]\ncommand = "d"\n'
    )
    const block = entries.get(getCodexRegistrationKey('marketplaces', 'm'))?.block

    expect(block).toContain('# keeps this one')
    expect(block).toContain('source = "s" # inline')
    expect(block).not.toContain('belongs to mcp_servers')
  })

  it('keeps a hash inside a multiline value out of the trailing-comment trim', () => {
    const entries = readCodexRegistrationEntries(
      '[marketplaces.m]\nnotes = """\n# not a comment"""\n\n[mcp_servers.docs]\ncommand = "d"\n'
    )
    const block = entries.get(getCodexRegistrationKey('marketplaces', 'm'))?.block

    expect(block).toContain('# not a comment"""')
  })

  it('ignores an array-of-tables header under a registration root', () => {
    expect(readCodexRegistrationEntries('[[marketplaces.m]]\nsource = "s"\n').size).toBe(0)
  })

  it('keys marketplace and plugin registrations in separate namespaces', () => {
    expect(MARKETPLACE_KEY).not.toBe(PLUGIN_KEY)
  })
})
