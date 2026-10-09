import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('runtime extraction regressions', () => {
  it('wires the managed Claude config directory into skill discovery', async () => {
    const runtime = new OrcaRuntimeService()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/claude/managed')
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir },
      codexAccounts: {},
      rateLimits: {}
    } as never)

    await expect(
      runtime.resolveSkillDiscoveryProviderRoots({ kind: 'native-host' })
    ).resolves.toMatchObject({ claude: join('/accounts/claude/managed', 'skills') })
    expect(getRuntimeConfigDir).toHaveBeenCalledWith({ runtime: 'host' })
  })

  it('does not create orchestration state for optional lineage lookups', () => {
    const runtime = new OrcaRuntimeService()
    const createDb = vi.spyOn(runtime, 'getOrchestrationDb')
    const internal = runtime as unknown as {
      getOrchestrationDbIfAvailable(): unknown
    }

    expect(internal.getOrchestrationDbIfAvailable()).toBeNull()
    expect(createDb).not.toHaveBeenCalled()
  })

  it('preserves the session-inventory capability gate in runtime status', () => {
    vi.stubEnv('ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY', '1')
    try {
      const runtime = new OrcaRuntimeService()
      expect(runtime.getStatus().capabilities).not.toContain(
        SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('publishes the answering runtime machine name in status', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test exercises status with only the store surface the runtime reads during construction.
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({ machineName: 'Build server' })
    } as RuntimeStore)
    expect(runtime.getStatus().machineName).toBe('Build server')
    expect(runtime.getStatus().hostPlatform).toBe(process.platform)
  })

  it('reads a machine rename the same way status publishes it', () => {
    const settings = { machineName: 'Build server' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test exercises status with only the store surface the runtime reads during construction.
    const runtime = new OrcaRuntimeService({ getSettings: () => settings } as RuntimeStore)
    expect(runtime.readMachineName()).toBe('Build server')
    settings.machineName = 'Renamed desk'
    expect(runtime.getStatus().machineName).toBe('Renamed desk')
    // The remote-workspace client identity reads this same accessor at send time.
    expect(runtime.readMachineName()).toBe('Renamed desk')
  })
})
