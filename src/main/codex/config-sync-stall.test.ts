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
    // Why: a directory at the config path survives existsSync but throws on
    // read, standing in for a permission-denied or otherwise unreadable home.
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

  // Why: the status must never claim a sync the mirror would decline, so pin it
  // to the mirror's real behavior rather than to a duplicated predicate.
  it('reports a stall exactly when the mirror preserves the runtime config', () => {
    writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)
    expect(getCodexConfigSyncStatus(homes).state).toBe('synced')

    rmSync(systemConfigPath())
    syncSystemConfigIntoManagedCodexHome(homes)

    expect(getCodexConfigSyncStatus(homes).state).toBe('stalled')
    // The mirror keeps serving the last good settings — that is what makes the
    // stall silent, and why it needs surfacing.
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

  // Why: a failing assertion skips an inline mockRestore, and a leaked
  // console.warn spy makes every later case in this block fail spuriously.
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
    // Why: an unreadable source throws out of the mirror, so before the catch
    // path reported it this stall logged the generic failure on every launch
    // and quota poll and never surfaced its reason.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Why: seed a baseline with one healthy pass first. Without it promotion
    // no-ops before touching the source and the mirror is what throws — which
    // is NOT the steady state every real install is in, where promotion reads
    // the source first and throws there instead.
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
    // Why: a removed runtime config also reads as synced, so "readable again"
    // would be a false claim about a source that is still gone.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(runtimeConfigPath(), 'model = "runtime-model"\n', 'utf-8')
    syncSystemConfigIntoManagedCodexHome(homes)

    rmSync(runtimeConfigPath())
    syncSystemConfigIntoManagedCodexHome(homes)

    const cleared = warn.mock.calls.filter((call) => String(call[0]).includes('stall cleared'))
    expect(cleared).toHaveLength(1)
    expect(String(cleared[0]?.[0])).not.toContain('readable again')
  })

  // chmod on a directory does not block writes on Windows, so promotion would
  // succeed there and the scenario could not be constructed.
  it.skipIf(process.platform === 'win32')(
    'does not claim recovery on a pass where no mirror ran',
    () => {
      // Why: promotion throwing still means the mirror was skipped, so the runtime
      // config is not tracking the source. Clearing the latch there would claim a
      // recovery that never happened and silence every later pass.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
      syncSystemConfigIntoManagedCodexHome(homes)

      // In-Codex change while the source is gone -> stall latches, and the change
      // stays pending promotion.
      rmSync(systemConfigPath())
      writeFileSync(runtimeConfigPath(), 'model = "o4"\n', 'utf-8')
      syncSystemConfigIntoManagedCodexHome(homes)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('stalled'))).toHaveLength(1)
      warn.mockClear()

      // Source returns readable, but promotion cannot write the pending change
      // back into a read-only ~/.codex, so it throws and the mirror is skipped.
      writeFileSync(systemConfigPath(), 'model = "gpt-5"\n', 'utf-8')
      chmodSync(homes.systemHomePath, 0o555)
      try {
        syncSystemConfigIntoManagedCodexHome(homes)
      } finally {
        chmodSync(homes.systemHomePath, 0o755)
      }

      expect(warn.mock.calls.filter((c) => String(c[0]).includes('stall cleared'))).toHaveLength(0)
      // The runtime never picked up the source, so the change must still be there.
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
