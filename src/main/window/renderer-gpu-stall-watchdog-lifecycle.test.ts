import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readMetricsMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { getAppMetrics: readMetricsMock } }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))

import { withPlatform } from './createMainWindow-test-harness'
import { installRendererGpuStallWatchdog } from './renderer-gpu-stall-watchdog'

function createWindow() {
  const handlers = new Map<string, () => void>()
  const webContents = {
    getOSProcessId: vi.fn(() => 100),
    executeJavaScript: vi.fn(() => new Promise<unknown>(() => {})),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    isDevToolsOpened: vi.fn(() => false),
    on: vi.fn((event: string, callback: () => void) => handlers.set(event, callback)),
    off: vi.fn((event: string) => handlers.delete(event))
  }
  return { window: { isDestroyed: () => false, webContents }, webContents, handlers }
}

function metrics(gpuWorkingSetKB: number) {
  return [
    {
      pid: 100,
      creationTime: 1,
      type: 'Tab',
      cpu: { cumulativeCPUUsage: 0 },
      memory: { workingSetSize: 1024 }
    },
    {
      pid: 200,
      creationTime: 1,
      type: 'GPU',
      cpu: { cumulativeCPUUsage: 0 },
      memory: { workingSetSize: gpuWorkingSetKB }
    }
  ]
}

describe('GPU watchdog installation and disposal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readMetricsMock.mockReset()
    vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('acts on one zero-working-set replacement and disposes its timer and listeners', async () => {
    const { window, webContents, handlers } = createWindow()
    readMetricsMock.mockReturnValue(metrics(0))
    const dispose = withPlatform('win32', () => installRendererGpuStallWatchdog(window, () => [0]))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(process.kill).toHaveBeenCalledOnce()
    expect(process.kill).toHaveBeenCalledWith(200, 'SIGKILL')
    dispose()
    expect(handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const pings = webContents.executeJavaScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(webContents.executeJavaScript).toHaveBeenCalledTimes(pings)
  })

  it('leaves a replacement with a nonzero working set alone', async () => {
    const { window } = createWindow()
    readMetricsMock.mockReturnValue(metrics(32_000))
    const dispose = withPlatform('win32', () => installRendererGpuStallWatchdog(window, () => [0]))
    await vi.advanceTimersByTimeAsync(24_000)
    expect(process.kill).not.toHaveBeenCalled()
    dispose()
  })

  it.each(['darwin', 'linux'] as const)('does not install polling on %s', (platform) => {
    const { window, webContents } = createWindow()
    const dispose = withPlatform(platform, () => installRendererGpuStallWatchdog(window, () => [0]))
    expect(webContents.on).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(readMetricsMock).not.toHaveBeenCalled()
    dispose()
  })

  it('forgets a ping from the previous renderer generation', async () => {
    const { window, webContents, handlers } = createWindow()
    readMetricsMock.mockReturnValue(metrics(0))
    const dispose = withPlatform('win32', () => installRendererGpuStallWatchdog(window, () => [0]))
    await vi.advanceTimersByTimeAsync(2_000)
    handlers.get('did-start-loading')?.()
    webContents.executeJavaScript.mockResolvedValue(0)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(process.kill).not.toHaveBeenCalled()
    dispose()
  })

  it('stops polling after destruction without calling methods on destroyed contents', async () => {
    const { window, webContents } = createWindow()
    readMetricsMock.mockReturnValue(metrics(0))
    const dispose = withPlatform('win32', () => installRendererGpuStallWatchdog(window, () => [0]))
    webContents.isDestroyed.mockReturnValue(true)
    dispose()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(webContents.off).not.toHaveBeenCalled()
    expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
