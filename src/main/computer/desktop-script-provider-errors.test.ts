import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStarted,
  mockDesktopProviderSubprocessThatIgnoresTimeout,
  resetDesktopScriptProviderTestHarness
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient errors and capabilities', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('rejects when the desktop provider subprocess ignores the exec timeout', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const once = vi.fn()
    mockDesktopProviderSubprocessThatIgnoresTimeout({ kill, once })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    const promise = client.listApps()
    let settled = false
    void promise.catch(() => {
      settled = true
    })

    await vi.waitFor(expectDesktopProviderSubprocessStarted, { timeout: 1_000 })
    await vi.advanceTimersByTimeAsync(30_001)
    await vi.runOnlyPendingTimersAsync()

    expect(settled).toBe(true)
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    await expect(promise).rejects.toMatchObject({ code: 'action_timeout' })
  })

  it('force-kills a timed-out desktop provider subprocess that has not exited', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const once = vi.fn()
    mockDesktopProviderSubprocessThatIgnoresTimeout({ kill, once })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    const promise = client.listApps().catch(() => undefined)

    await vi.waitFor(expectDesktopProviderSubprocessStarted, { timeout: 1_000 })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(kill).toHaveBeenCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    await promise
  })
})
