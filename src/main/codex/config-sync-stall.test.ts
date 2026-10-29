import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getCodexConfigSyncStatus,
  reportCodexConfigSyncOutcome,
  resetCodexConfigSyncStallLatchForTests
} from './config-sync-stall'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { getCodexSettingsBaselinePath } from './config-settings-baseline'

// Bypass platform-specific socket paths so asserted config bytes stay host-independent.
vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

let root: string
let homes: { runtimeHomePath: string; systemHomePath: string }

function systemConfigPath(): string {
  return join(homes.systemHomePath, 'config.toml')
}

function runtimeConfigPath(): string {
  return join(homes.runtimeHomePath, 'config.toml')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-sync-stall-'))
  homes = { runtimeHomePath: join(root, 'runtime'), systemHomePath: join(root, 'system') }
  mkdirSync(homes.runtimeHomePath, { recursive: true })
  mkdirSync(homes.systemHomePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('getCodexConfigSyncStatus', () => {
  it('reports synced while the source config is usable', () => {
    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    writeFileSync(runtimeConfigPath(), 'model = "gpt-5"\n', 'utf-8')

    expect(getCodexConfigSyncStatus(homes)).toEqual({
      state: 'synced',
      reason: null,
      systemConfigPath: systemConfigPath()
    })
  })

  it('reports a stall when the source config is missing', () => {
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')

    expect(getCodexConfigSyncStatus(homes)).toEqual({
      state: 'stalled',
      reason: 'missing-source',
      systemConfigPath: systemConfigPath()
    })
  })

  it('reports a stall when the source config is blank', () => {
    writeFileSync(systemConfigPath(), '\n  \n', 'utf-8')
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')

    expect(getCodexConfigSyncStatus(homes).reason).toBe('blank-source')
  })

  it('reports a stall when the source config cannot be read', () => {
    // A directory at the config path simulates a present but unreadable file.
    mkdirSync(systemConfigPath(), { recursive: true })
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')

    expect(getCodexConfigSyncStatus(homes).reason).toBe('unreadable-source')
  })

  it('reports a stall when the settings baseline cannot be read', () => {
    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    writeFileSync(runtimeConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    const baselinePath = getCodexSettingsBaselinePath(homes.runtimeHomePath)
    mkdirSync(baselinePath)

    expect(getCodexConfigSyncStatus(homes)).toEqual({
      state: 'stalled',
      reason: 'managed-home-unavailable',
      systemConfigPath: systemConfigPath(),
      managedStatePath: baselinePath
    })
  })

  it('stays synced before the runtime config exists, since nothing can fall behind yet', () => {
    expect(getCodexConfigSyncStatus(homes)).toEqual({
      state: 'synced',
      reason: null,
      systemConfigPath: systemConfigPath()
    })
  })

  it('reports a stall exactly when the mirror preserves the runtime config', () => {
    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)
    expect(getCodexConfigSyncStatus(homes).state).toBe('synced')

    rmSync(systemConfigPath())
    syncSystemConfigIntoManagedCodexHome(homes)

    expect(getCodexConfigSyncStatus(homes).state).toBe('stalled')
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('model = "gpt-5"')
  })

  it('clears the stall once the source config returns', () => {
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    expect(getCodexConfigSyncStatus(homes).state).toBe('stalled')

    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')

    expect(getCodexConfigSyncStatus(homes).state).toBe('synced')
  })
})

describe('reportCodexConfigSyncOutcome', () => {
  beforeEach(() => {
    resetCodexConfigSyncStallLatchForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a stall once per episode rather than on every sync pass', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')

    for (let pass = 0; pass < 3; pass += 1) {
      syncSystemConfigIntoManagedCodexHome(homes)
    }

    expect(warn.mock.calls.filter((call) => String(call[0]).includes('stalled'))).toHaveLength(1)
  })

  it('logs once when the stall clears after the source config returns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)

    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)
    syncSystemConfigIntoManagedCodexHome(homes)

    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('stall cleared'))
    ).toHaveLength(1)
  })

  it('latches an unreadable source instead of logging the raw failure every pass', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Seed a baseline so the unreadable source fails during promotion, before the mirror.
    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)
    warn.mockClear()

    rmSync(systemConfigPath())
    mkdirSync(systemConfigPath(), { recursive: true })

    for (let pass = 0; pass < 3; pass += 1) {
      syncSystemConfigIntoManagedCodexHome(homes)
    }

    const stallLogs = warn.mock.calls.filter((call) => String(call[0]).includes('stalled'))
    expect(stallLogs).toHaveLength(1)
    expect(String(stallLogs[0]?.[0])).toContain('unreadable-source')
  })

  it('names the managed config when that is the unreadable file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    mkdirSync(runtimeConfigPath())

    reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes))

    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain(runtimeConfigPath())
    expect(message).not.toContain(systemConfigPath())
    expect(message).toContain('The managed state must be readable before settings can sync.')
  })

  it('clears a stall without claiming the source became readable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)

    rmSync(runtimeConfigPath())
    syncSystemConfigIntoManagedCodexHome(homes)

    const cleared = warn.mock.calls.filter((call) => String(call[0]).includes('stall cleared'))
    expect(cleared).toHaveLength(1)
    expect(String(cleared[0]?.[0])).not.toContain('readable again')
  })

  // Windows directory chmod cannot simulate this write failure.
  it.skipIf(process.platform === 'win32')(
    'does not claim recovery on a pass where no mirror ran',
    () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
      syncSystemConfigIntoManagedCodexHome(homes)

      rmSync(systemConfigPath())
      writeFileSync(runtimeConfigPath(), 'model = "o4"\n', 'utf-8')
      syncSystemConfigIntoManagedCodexHome(homes)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('stalled'))).toHaveLength(1)
      warn.mockClear()

      // Readable source plus an unwritable home fails promotion and skips the mirror.
      writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
      chmodSync(homes.systemHomePath, 0o555)
      try {
        syncSystemConfigIntoManagedCodexHome(homes)
      } finally {
        chmodSync(homes.systemHomePath, 0o755)
      }

      expect(warn.mock.calls.filter((c) => String(c[0]).includes('stall cleared'))).toHaveLength(0)
      expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('model = "o4"')
    }
  )

  it('logs again when the stall reason changes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)

    writeFileSync(systemConfigPath(), '   \n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)

    const stallLogs = warn.mock.calls.filter((call) => String(call[0]).includes('stalled'))
    expect(stallLogs).toHaveLength(2)
    expect(String(stallLogs[1]?.[0])).toContain('blank-source')
  })
})
