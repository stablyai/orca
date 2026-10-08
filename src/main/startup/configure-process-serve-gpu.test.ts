import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/app-data'),
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    commandLine: {
      appendSwitch: vi.fn(),
      getSwitchValue: vi.fn(() => '')
    }
  }
}))

// Serve-mode GPU caps live apart from configure-process.test.ts to keep that file under max-lines.
describe('enableMainProcessGpuFeatures serve mode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_E2E_USER_DATA_DIR
    delete process.env.ORCA_GPU_MEM_AVAILABLE_MB
  })

  it('serve mode caps GPU memory and forces PurgeAndSuspend', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    enableMainProcessGpuFeatures({ isServeMode: true })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('force-gpu-mem-available-mb', '512')
    const enableFeatures = vi
      .mocked(app.commandLine.appendSwitch)
      .mock.calls.filter(([flag]) => flag === 'enable-features')
      .map(([, value]) => String(value))
      .join(',')
    expect(enableFeatures).toContain('PurgeAndSuspend')
  })

  it('serve mode honours ORCA_GPU_MEM_AVAILABLE_MB override', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    process.env.ORCA_GPU_MEM_AVAILABLE_MB = '1024'
    vi.mocked(app.commandLine.appendSwitch).mockClear()
    enableMainProcessGpuFeatures({ isServeMode: true })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('force-gpu-mem-available-mb', '1024')
  })

  it('desktop mode leaves serve GPU caps off', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    enableMainProcessGpuFeatures({ isServeMode: false })

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith(
      'force-gpu-mem-available-mb',
      expect.any(String)
    )
  })
})
