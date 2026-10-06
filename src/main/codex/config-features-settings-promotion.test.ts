import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'

// Why: temp homes exceed sun_path on macOS but not on Linux; keep asserted config bytes host-independent.
vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { upsertTableSettingsInContent } from './codex-config-settings-upsert'
import { CODEX_DAEMON_OVERRIDE_MARKER } from './codex-daemon-socket-path-guard'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-features-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-features-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  // Why: promotion writes into homedir()/.codex; refuse to run against the real one.
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

const systemConfigPath = (): string => join(tmpHome, '.codex', 'config.toml')
const runtimeHomeDir = (): string => join(userDataDir, 'codex-runtime-home', 'home')
const runtimeConfigPath = (): string => join(runtimeHomeDir(), 'config.toml')
const baselinePath = (): string => join(runtimeHomeDir(), '.orca-config-settings-baseline.json')
const readSystemConfig = (): string => readFileSync(systemConfigPath(), 'utf-8')
const readRuntimeConfig = (): string => readFileSync(runtimeConfigPath(), 'utf-8')

function writeSystemConfig(content: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

function setRuntimeConfig(content: string): void {
  mkdirSync(runtimeHomeDir(), { recursive: true })
  writeFileSync(runtimeConfigPath(), content, 'utf-8')
}

// Mimics `codex features disable daemon_auto_start` run with CODEX_HOME = Orca's mirror home.
function turnOffInMirror(raw = 'false'): void {
  const existing = existsSync(runtimeConfigPath()) ? readRuntimeConfig() : ''
  setRuntimeConfig(
    upsertTableSettingsInContent(existing, 'features', new Map([['daemon_auto_start', raw]]))
  )
}

describe('[features].daemon_auto_start write-back promotion', () => {
  it('creates ~/.codex/config.toml with the runtime settings when the user has none', () => {
    setRuntimeConfig('model = "o4"\n')
    syncSystemConfigIntoManagedCodexHome()
    turnOffInMirror()

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "o4"\n\n[features]\ndaemon_auto_start = false\n')
    expect(readRuntimeConfig()).toContain('daemon_auto_start = false')
    // Why: the next pass mirrors the promoted source, so the setting must survive it.
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toContain('daemon_auto_start = false')
  })

  it('seeds a blank ~/.codex/config.toml from the runtime instead of a skeleton', () => {
    writeSystemConfig(' \n')
    setRuntimeConfig('model = "o4"\n')
    syncSystemConfigIntoManagedCodexHome()
    turnOffInMirror()

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "o4"\n\n[features]\ndaemon_auto_start = false\n')
    expect(readRuntimeConfig()).toContain('model = "o4"')
  })

  it('holds the change while the source is missing and promotes it once the source returns', () => {
    writeSystemConfig('model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n')
    syncSystemConfigIntoManagedCodexHome()
    rmSync(systemConfigPath())
    turnOffInMirror()

    syncSystemConfigIntoManagedCodexHome()
    expect(existsSync(systemConfigPath())).toBe(false)
    expect(readRuntimeConfig()).toContain('daemon_auto_start = false')

    writeSystemConfig('model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n')
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe('model = "gpt-5"\n\n[features]\ndaemon_auto_start = false\n')
    expect(readRuntimeConfig()).toContain('daemon_auto_start = false')
  })

  it('adds the key to an existing [features] table without touching its other keys', () => {
    writeSystemConfig('model = "gpt-5"\n\n[features]\ncodex_hooks = true\napps = false\n')
    syncSystemConfigIntoManagedCodexHome()
    turnOffInMirror()

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\n\n[features]\ncodex_hooks = true\napps = false\ndaemon_auto_start = false\n'
    )
    // The runtime keeps its own hooks spelling; only the promoted key crosses over.
    expect(readRuntimeConfig()).toContain('hooks = true')
    const settled = readSystemConfig()
    syncSystemConfigIntoManagedCodexHome()
    expect(readSystemConfig()).toBe(settled)
  })

  it('appends a [features] table when the source has none', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()
    turnOffInMirror()

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n\n[features]\ndaemon_auto_start = false\n'
    )
  })

  it('replaces a source daemon_auto_start = true in place', () => {
    writeSystemConfig('[features]\nhooks = true\ndaemon_auto_start = true\napps = true\n')
    syncSystemConfigIntoManagedCodexHome()
    turnOffInMirror()

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe(
      '[features]\nhooks = true\ndaemon_auto_start = false\napps = true\n'
    )
    expect(readRuntimeConfig()).toContain('daemon_auto_start = false')
  })

  it('keeps a source edit made while the runtime also changed, as for every promoted key', () => {
    writeSystemConfig('[features]\ndaemon_auto_start = true\n')
    syncSystemConfigIntoManagedCodexHome()
    turnOffInMirror()
    writeSystemConfig('[features]\ndaemon_auto_start = "outside-edit"\n')

    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('[features]\ndaemon_auto_start = "outside-edit"\n')
    expect(readRuntimeConfig()).toContain('daemon_auto_start = "outside-edit"')
  })

  it('keeps the runtime value for a baseline written before the key was promoted', () => {
    writeSystemConfig('[features]\ndaemon_auto_start = true\n')
    syncSystemConfigIntoManagedCodexHome()
    const baseline = JSON.parse(readFileSync(baselinePath(), 'utf-8'))
    delete baseline.settings['features.daemon_auto_start']
    writeFileSync(baselinePath(), JSON.stringify(baseline), 'utf-8')
    turnOffInMirror()

    // Why: without a recorded ancestor neither side is known to be newer, so both are kept.
    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('[features]\ndaemon_auto_start = true\n')
    expect(readRuntimeConfig()).toContain('daemon_auto_start = false')
  })

  it("never promotes Orca's own daemon socket override", () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    rmSync(systemConfigPath())
    turnOffInMirror(`false ${CODEX_DAEMON_OVERRIDE_MARKER}`)

    syncSystemConfigIntoManagedCodexHome()

    expect(existsSync(systemConfigPath())).toBe(false)
  })
})
