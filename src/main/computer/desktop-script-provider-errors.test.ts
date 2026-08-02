import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStarted,
  mockDesktopProviderSubprocessThatIgnoresTimeout,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient errors and capabilities', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('explains screenshot capture failures while keeping accessibility state usable', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        screenshotPngBase64: null
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).resolves.toMatchObject({
      snapshot: {
        elementCount: 1
      },
      screenshotStatus: {
        state: 'failed',
        code: 'screenshot_failed',
        message: expect.stringContaining('--no-screenshot')
      }
    })
  })

  it('preserves desktop provider screenshot failure reasons', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        screenshotPngBase64: null,
        screenshotError: {
          code: 'screenshot_failed',
          message:
            'screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window'
        }
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).resolves.toMatchObject({
      snapshot: {
        elementCount: 1
      },
      screenshotStatus: {
        state: 'failed',
        code: 'screenshot_failed',
        message: expect.stringContaining('payload cap')
      }
    })
  })

  it('normalizes list-windows responses after provider handshake', async () => {
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse({
      ok: true,
      app: { name: 'Text Editor', bundleIdentifier: 'Text Editor', pid: 100 },
      windows: [
        {
          index: 0,
          app: { name: 'Text Editor', bundleIdentifier: 'Text Editor', pid: 100 },
          id: 99,
          title: 'Document',
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          isMinimized: false,
          isOffscreen: false,
          screenIndex: null,
          platform: { backend: 'at-spi' }
        }
      ]
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.listWindows({ app: 'Text Editor' })).resolves.toMatchObject({
      app: { name: 'Text Editor', bundleId: 'Text Editor', pid: 100 },
      windows: [{ index: 0, id: 99, title: 'Document' }]
    })
  })

  it('maps bridge app errors to RuntimeClientError codes', async () => {
    mockBridgeResponse({ ok: false, error: 'appNotFound("Missing")' })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Missing' })).rejects.toMatchObject({
      code: 'app_not_found'
    })
  })

  it('maps blocked app bridge errors to a policy error', async () => {
    mockBridgeResponse({ ok: false, error: 'appBlocked("1Password")' })

    const client = await createDesktopScriptProviderClient('windows', '/tmp/runtime.ps1')

    await expect(client.snapshot({ app: '1Password' })).rejects.toMatchObject({
      code: 'app_blocked'
    })
  })

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
