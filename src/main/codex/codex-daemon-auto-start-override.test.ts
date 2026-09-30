import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('tests pass explicit homes')
    }
  }
}))

import {
  applyCodexDaemonAutoStartOverride,
  stripCodexDaemonOverride
} from './codex-daemon-auto-start-override'
import {
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'
import { ensureCodexDaemonAutoStartOverride } from './codex-daemon-auto-start-override-write'
import { getCodexConfigSyncStatus } from './config-sync-stall'
import { getCodexSettingsBaselinePath } from './config-settings-baseline'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'

const UUID = '9dd962e2-449d-44c4-9733-0633f255064a'
const MAC_MANAGED_HOME = `/Users/john/Library/Application Support/orca/codex-accounts/${UUID}/home`
// Spelled out, not built from the constant: older Orca builds strip only this exact line.
const OVERRIDE_LINE = 'daemon_auto_start = false # orca: CODEX_HOME too long for the daemon socket'
const WINDOWS_MANAGED_HOME = 'C:\\Users\\neil\\AppData\\Roaming\\orca\\codex-runtime-home\\home'

const SHORT_HOME = '/orca/home'

describe('applyCodexDaemonAutoStartOverride', () => {
  it('appends a [features] table when none exists and strips back to the original', () => {
    const config = 'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n'
    const guarded = applyCodexDaemonAutoStartOverride(config, MAC_MANAGED_HOME)
    expect(guarded).toBe(`${config}\n[features]\n${OVERRIDE_LINE}\n`)
    expect(applyCodexDaemonAutoStartOverride(guarded, MAC_MANAGED_HOME)).toBe(guarded)
    expect(stripCodexDaemonOverride(guarded)).toBe(config)
  })

  it('writes into an existing [features] table and overrides an explicit true', () => {
    const config = '[features]\nhooks = true\ndaemon_auto_start = true\n\n[tui]\ntheme = "dark"\n'
    const guarded = applyCodexDaemonAutoStartOverride(config, MAC_MANAGED_HOME)
    expect(guarded).toBe(`[features]\nhooks = true\n${OVERRIDE_LINE}\n\n[tui]\ntheme = "dark"\n`)
    expect(stripCodexDaemonOverride(guarded)).toBe(
      '[features]\nhooks = true\n\n[tui]\ntheme = "dark"\n'
    )
  })

  it('uses a dotted key beside dotted features keys so the table is not defined twice', () => {
    const config = 'features.hooks = true\n\n[tui]\ntheme = "dark"\n'
    expect(applyCodexDaemonAutoStartOverride(config, MAC_MANAGED_HOME)).toBe(
      `features.hooks = true\nfeatures.${OVERRIDE_LINE}\n\n[tui]\ntheme = "dark"\n`
    )
  })

  it('creates a config for an empty home and keeps CRLF files CRLF', () => {
    expect(applyCodexDaemonAutoStartOverride('', MAC_MANAGED_HOME)).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    const crlf = 'model = "gpt-5"\r\n'
    const guarded = applyCodexDaemonAutoStartOverride(crlf, MAC_MANAGED_HOME)
    expect(guarded).toBe(`model = "gpt-5"\r\n\r\n[features]\r\n${OVERRIDE_LINE}\r\n`)
    expect(stripCodexDaemonOverride(guarded)).toBe(crlf)
  })

  it('turns auto-start off in homes whose socket path fits, too', () => {
    expect(applyCodexDaemonAutoStartOverride('model = "m"\n', WINDOWS_MANAGED_HOME)).toBe(
      `model = "m"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    const guarded = applyCodexDaemonAutoStartOverride('model = "m"\n', MAC_MANAGED_HOME)
    expect(applyCodexDaemonAutoStartOverride(guarded, SHORT_HOME)).toBe(guarded)
  })

  it("overrides the user's explicit true in every TOML form Orca can extend, and says so once", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = SHORT_HOME
    expect(applyCodexDaemonAutoStartOverride('[features]\ndaemon_auto_start = true\n', home)).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    expect(applyCodexDaemonAutoStartOverride('features.daemon_auto_start = true\n', home)).toBe(
      `features.${OVERRIDE_LINE}\n`
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('daemon_auto_start = true')
    expect(String(warn.mock.calls[0]?.[0])).toContain(home)
    warn.mockRestore()
  })

  it("marks a user's explicit false as Orca's without warning about an override", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = `${SHORT_HOME}-false`
    expect(applyCodexDaemonAutoStartOverride('[features]\ndaemon_auto_start = false\n', home)).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores a same-named key outside [features] or inside a multiline string', () => {
    const config =
      '[tui]\ndaemon_auto_start = true\nnote = """\n[features]\ndaemon_auto_start = true\n"""\n'
    expect(applyCodexDaemonAutoStartOverride(config, SHORT_HOME)).toBe(
      `${config}\n[features]\n${OVERRIDE_LINE}\n`
    )
  })

  it('warns once instead of failing silently when inline features block the override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = `${MAC_MANAGED_HOME}-inline`
    const config = 'features = { hooks = true }\n'
    expect(applyCodexDaemonAutoStartOverride(config, home)).toBe(config)
    applyCodexDaemonAutoStartOverride(config, home)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('Could not turn off Codex daemon auto-start')
    expect(String(warn.mock.calls[0]?.[0])).toContain('as a [features] table')
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('add daemon_auto_start = false')
    const alreadyOff = 'features = { daemon_auto_start = false }\n'
    applyCodexDaemonAutoStartOverride(alreadyOff, `${home}-off`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('never promotes the override into a seeded ~/.codex', () => {
    const guarded = applyCodexDaemonAutoStartOverride('model = "m"\n', MAC_MANAGED_HOME)
    expect(extractOrdinaryCodexSettings(guarded)).toBe('model = "m"')
  })
})

describe('syncSystemConfigIntoManagedCodexHome daemon guard', () => {
  let root: string
  let systemHomePath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cx-'))
    systemHomePath = join(root, 's')
    mkdirSync(systemHomePath)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeHome(name: string): string {
    const home = join(root, name)
    mkdirSync(home, { recursive: true })
    return home
  }

  const longHome = (): string =>
    makeHome(join('Library', 'Application Support', 'orca', 'codex-accounts', UUID, 'home'))

  it('turns daemon auto-start off in a long managed home without touching ~/.codex', () => {
    const systemConfig = 'model = "gpt-5"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    const runtimeHomePath = longHome()

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    const first = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
    expect(first).toBe(`model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`)

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(first)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
  })

  it('still guards a long home when the user has no ~/.codex/config.toml', () => {
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    // A guard-only runtime config withholds no settings, so it must not raise the missing-source warning.
    expect(getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath }).state).toBe('synced')
  })

  it('still guards an existing home when a stalled settings write-back skips the mirror', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const runtimeHomePath = longHome()
    writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "runtime"\n')
    // An unreadable baseline makes promotion refuse, so no mirror pass runs.
    mkdirSync(getCodexSettingsBaselinePath(runtimeHomePath))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    warn.mockRestore()
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "runtime"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('mirrors a later-created ~/.codex/config.toml into a guard-only home', () => {
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('still reports a real stall when the runtime holds user settings and the source is gone', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    rmSync(join(systemHomePath, 'config.toml'))
    expect(getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath })).toMatchObject({
      state: 'stalled',
      reason: 'missing-source'
    })
  })

  it('keeps the guard in the legacy shared home when a system launch refreshes it', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const runtimeHomePath = longHome()
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      `model = "old"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    syncSystemConfigIntoLegacySharedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain(OVERRIDE_LINE)
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain('model = "gpt-5"')
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('turns auto-start off in a short managed home too, leaving ~/.codex untouched', () => {
    const systemConfig = 'model = "gpt-5"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    const runtimeHomePath = makeHome('h')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath }).state).toBe('synced')
  })

  it('overrides an explicit true from ~/.codex in a short managed home, leaving ~/.codex untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const systemConfig = 'model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    const runtimeHomePath = makeHome('h')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(
      warn.mock.calls.filter(([m]) => String(m).includes('daemon_auto_start = true'))
    ).toHaveLength(1)
    warn.mockRestore()
  })

  it("refuses the user's own home as the target even when its spelling differs", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const systemConfig = 'model = "gpt-5"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: `${systemHomePath}/`, systemHomePath })
    ensureCodexDaemonAutoStartOverride(`${systemHomePath}//`, systemHomePath)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
    // Refused before any disk access, so an unreachable distro path is safe here.
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex',
      systemHomePath: '\\\\wsl$\\ubuntu\\home\\u\\.codex'
    })
    const refusals = warn.mock.calls.filter(([m]) => String(m).includes('Refusing to write'))
    expect(refusals).toHaveLength(2)
    warn.mockRestore()
  })

  it('still overrides an explicit true where the socket cannot be bound at all', () => {
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      'model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n'
    )
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
  })
})
