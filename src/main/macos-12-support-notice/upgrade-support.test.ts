import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, app, system } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  app: { runningUnderARM64Translation: false },
  system: { release: '21.6.0' }
}))

vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('electron', () => ({ app }))
vi.mock('node:os', () => ({ release: () => system.release }))

describe('local macOS upgrade probe', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    app.runningUnderARM64Translation = false
    system.release = '21.6.0'
  })

  afterEach(() => vi.restoreAllMocks())

  it('coalesces model reads and recommends Linux only for a known unsupported Intel model', async () => {
    runProcess.mockResolvedValue({ code: 0, stdout: 'MacBookPro13,3\n' })
    const { getMacosUpgradeSupport } = await import('./upgrade-support')
    const results = await Promise.all([getMacosUpgradeSupport(), getMacosUpgradeSupport()])
    expect(results).toEqual([
      { macos13: 'unsupported', modelIdentifier: 'MacBookPro13,3' },
      { macos13: 'unsupported', modelIdentifier: 'MacBookPro13,3' }
    ])
    expect(runProcess).toHaveBeenCalledOnce()
  })

  it('recognizes Apple Silicon even when Orca runs as x64 under Rosetta', async () => {
    app.runningUnderARM64Translation = true
    const { getMacosUpgradeSupport } = await import('./upgrade-support')
    expect(await getMacosUpgradeSupport()).toEqual({ macos13: 'supported', modelIdentifier: null })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('falls back to checking compatibility when the bounded model probe fails', async () => {
    runProcess.mockRejectedValue(new Error('sysctl unavailable'))
    const { getMacosUpgradeSupport } = await import('./upgrade-support')
    expect(await getMacosUpgradeSupport()).toEqual({ macos13: 'unknown', modelIdentifier: null })
  })

  it('never probes other platforms or newer macOS releases', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { getMacosUpgradeSupport } = await import('./upgrade-support')
    expect(await getMacosUpgradeSupport()).toBeNull()
    platform.mockReturnValue('darwin')
    system.release = '22.0.0'
    expect(await getMacosUpgradeSupport()).toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
