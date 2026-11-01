import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setSpawnObserver: vi.fn(),
  churnEnabled: false,
  recordSubprocessSpawn: vi.fn()
}))
vi.mock('@orca/process-host/spawn-observer', () => ({ setSpawnObserver: mocks.setSpawnObserver }))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({
  isMainThreadDiagnosticsEnabled: () => mocks.churnEnabled,
  recordSubprocessSpawn: mocks.recordSubprocessSpawn
}))

const { installMainSpawnObserver } = await import('./main-spawn-observer')

describe('installMainSpawnObserver', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    mocks.setSpawnObserver.mockReset()
    mocks.recordSubprocessSpawn.mockReset()
    mocks.churnEnabled = false
  })

  it('installs nothing with both diagnostics off, so spawns stay unmeasured', () => {
    installMainSpawnObserver()
    expect(mocks.setSpawnObserver).not.toHaveBeenCalled()
  })

  it('traces wsl.exe spawns through process-host when the WSL spawn trace is on', () => {
    vi.stubEnv('ORCA_WSL_SPAWN_TRACE', '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installMainSpawnObserver()
    const observer = mocks.setSpawnObserver.mock.calls[0]?.[0]

    observer?.('C:\\WINDOWS\\System32\\wsl.exe', ['-d', 'Ubuntu', '--exec', 'true'], 1)

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[wsl-spawn-trace] spawn process-host distro=Ubuntu')
    )
    expect(mocks.recordSubprocessSpawn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
