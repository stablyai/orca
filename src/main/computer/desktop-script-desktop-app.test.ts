import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  callDesktopScriptDesktopApp,
  resetLinuxScrollRemaindersForTest
} from './desktop-script-desktop-app'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness
} from './desktop-script-provider-test-harness'

const sampleWindow = {
  windowId: 4242,
  pid: 77,
  appName: 'Notepad',
  bundleId: null,
  title: 'notes.txt',
  bounds: { x: 0, y: 0, width: 800, height: 600 }
}

describe('callDesktopScriptDesktopApp', () => {
  afterEach(resetLinuxScrollRemaindersForTest)

  it('lists windows and excludes the Orca main process', async () => {
    const callBridge = vi.fn(async () => ({ ok: true, desktopWindows: [sampleWindow] }))
    await expect(
      callDesktopScriptDesktopApp(callBridge, 'listDesktopWindows', {}, 1234)
    ).resolves.toEqual({ windows: [sampleWindow] })
    expect(callBridge).toHaveBeenCalledWith({ tool: 'list_desktop_windows', excludePid: 1234 })
  })

  it('returns an empty list when the runtime omits windows', async () => {
    const callBridge = vi.fn(async () => ({ ok: true }))
    await expect(
      callDesktopScriptDesktopApp(callBridge, 'listDesktopWindows', {}, 1)
    ).resolves.toEqual({ windows: [] })
  })

  it('forwards input and normalizes the delivery path', async () => {
    const input = { kind: 'text', text: 'hi' }
    const callBridge = vi.fn(async () => ({ ok: true, path: 'unexpected' }))
    await expect(
      callDesktopScriptDesktopApp(callBridge, 'desktopInput', { pid: 77, windowId: 4242, input })
    ).resolves.toEqual({ path: 'synthetic' })
    expect(callBridge).toHaveBeenCalledWith({
      tool: 'desktop_input',
      pid: 77,
      windowId: 4242,
      input
    })
  })

  it('sends only whole X11 wheel steps on Linux and keeps the rest for the next frame', async () => {
    const callBridge = vi.fn(async () => ({ ok: true, path: 'synthetic' }))
    const scroll = (deltaY: number) =>
      callDesktopScriptDesktopApp(
        callBridge,
        'desktopInput',
        { pid: 77, windowId: 4242, input: { kind: 'scroll', x: 1, y: 1, deltaX: 0, deltaY } },
        1,
        'linux'
      )
    await scroll(20)
    await scroll(20)
    expect(callBridge).not.toHaveBeenCalled()
    await scroll(20)
    expect(callBridge).toHaveBeenCalledTimes(1)
    expect(callBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ deltaX: 0, deltaY: 50 }) })
    )
    await scroll(-20)
    expect(callBridge).toHaveBeenCalledTimes(1)
  })

  it('forwards scroll deltas unchanged on Windows', async () => {
    const callBridge = vi.fn(async () => ({ ok: true, path: 'synthetic' }))
    const input = { kind: 'scroll', x: 1, y: 1, deltaX: 0, deltaY: 3 }
    await callDesktopScriptDesktopApp(
      callBridge,
      'desktopInput',
      { pid: 77, windowId: 4242, input },
      1,
      'windows'
    )
    expect(callBridge).toHaveBeenCalledWith(expect.objectContaining({ input }))
  })

  it('rejects malformed targets before reaching the runtime', async () => {
    const callBridge = vi.fn()
    await expect(
      callDesktopScriptDesktopApp(callBridge, 'desktopInput', { pid: 0, windowId: 1, input: {} })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(
      callDesktopScriptDesktopApp(callBridge, 'desktopInput', { pid: 1, windowId: 1 })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callBridge).not.toHaveBeenCalled()
  })
})

describe('DesktopScriptProviderClient.desktopApp', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it.each(['windows', 'linux'] as const)(
    'routes the window list to the %s runtime',
    async (platform) => {
      mockBridgeResponse({ ok: true, desktopWindows: [sampleWindow] }, (operation) => {
        expect(operation.tool).toBe('list_desktop_windows')
        expect(operation.excludePid).toBe(process.ppid)
      })
      const client = await createDesktopScriptProviderClient(platform, '/tmp/runtime')
      await expect(client.desktopApp('listDesktopWindows', {})).resolves.toEqual({
        windows: [sampleWindow]
      })
    }
  )

  it('degrades to unsupported_capability when the runtime cannot reach other windows', async () => {
    mockBridgeResponse({
      ok: false,
      error: 'unsupported capability: Wayland does not let apps list or control other windows'
    })
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    await expect(client.desktopApp('listDesktopWindows', {})).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
  })

  it('maps runtime target errors to stable codes', async () => {
    mockBridgeResponse({ ok: false, error: 'window_not_found: window 9 is gone' })
    mockBridgeResponse({ ok: false, error: 'invalid_argument: point is outside the window' })
    const client = await createDesktopScriptProviderClient('windows', '/tmp/runtime.ps1')
    const input = { kind: 'click', x: 1, y: 1, button: 'left', clickCount: 1 }
    await expect(
      client.desktopApp('desktopInput', { pid: 7, windowId: 9, input })
    ).rejects.toMatchObject({ code: 'window_not_found' })
    await expect(
      client.desktopApp('desktopInput', { pid: 7, windowId: 9, input })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})
