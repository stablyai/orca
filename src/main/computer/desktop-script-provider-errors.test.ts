import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStarted,
  mockDesktopProviderSubprocessThatIgnoresTimeout,
  resetDesktopScriptProviderTestHarness
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient errors and capabilities', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

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
