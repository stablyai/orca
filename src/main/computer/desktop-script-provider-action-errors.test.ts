import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient action errors', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('maps action-specific bridge errors to actionable codes', async () => {
    mockBridgeResponse({ ok: false, error: 'element value is not settable' })
    mockBridgeResponse({ ok: false, error: 'Raise is not a valid secondary action' })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'value_not_settable'
    })
    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'action_not_supported'
    })
  })

  it('maps native validation bridge errors to invalid arguments', async () => {
    mockBridgeResponse({ ok: false, error: 'unsupported scroll direction: diagonal' })
    mockBridgeResponse({ ok: false, error: 'x is required' })
    mockBridgeResponse({ ok: false, error: 'text is required' })
    mockBridgeResponse({ ok: false, error: 'click_count must be a positive integer' })
    mockBridgeResponse({ ok: false, error: 'Unsupported key: Nope' })

    const client = await createDesktopScriptProviderClient('windows', '/tmp/runtime.ps1')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('does not confuse permission setup errors with invalid arguments', async () => {
    mockBridgeResponse({ ok: false, error: 'Accessibility permission is required' })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'permission_denied'
    })
  })

  it('does not confuse accessibility permission failures with missing windows', async () => {
    mockBridgeResponse({
      ok: false,
      error:
        "app 'Text Editor' has visible windows but no accessibility window. Accessibility permission may need to be toggled."
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'permission_denied'
    })
  })

  it('maps keyboard focus bridge errors to window_not_focused', async () => {
    mockBridgeResponse({
      ok: false,
      error:
        'window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window'
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'window_not_focused'
    })
  })

  it('maps bridge screenshot capture errors to screenshot_failed', async () => {
    mockBridgeResponse({
      ok: false,
      error: 'screenshot_failed: Screen Recording permission is required'
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'screenshot_failed'
    })
  })

  it('maps missing Linux keyboard dependencies to unsupported capability', async () => {
    mockBridgeResponse({
      ok: false,
      error: 'GDK is required for non-character key synthesis'
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
  })

  it('rejects actions that the provider does not advertise', async () => {
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities({
        hotkey: false,
        pasteText: false
      })
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(
      client.action('pasteText', { app: 'Text Editor', text: 'hello' })
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringContaining('actions.pasteText')
    })
  })

  it('rejects malformed action payloads before launching the native bridge', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.action('click', { elementIndex: 0 })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing app')
    })
    await expect(client.action('click', { app: 'Text Editor' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Click requires')
    })
    await expect(
      client.action('click', { app: 'Text Editor', windowId: 1, windowIndex: 0, x: 1, y: 2 })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('either windowId or windowIndex')
    })
    await expect(
      client.action('scroll', { app: 'Text Editor', elementIndex: 0, direction: 'diagonal' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Unsupported direction')
    })
    await expect(
      client.action('drag', { app: 'Text Editor', fromX: 1, fromY: 2 })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Drag coordinates')
    })
    await expect(
      client.action('performSecondaryAction', { app: 'Text Editor', elementIndex: 0 })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing action')
    })
    await expect(client.action('typeText', { app: 'Text Editor', text: '' })).rejects.toMatchObject(
      {
        code: 'invalid_argument',
        message: expect.stringContaining('Missing text')
      }
    )
    await expect(
      client.action('pressKey', { app: 'Text Editor', key: 'CmdOrCtrl+V' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Press-key accepts one key only')
    })
    await expect(client.action('hotkey', { app: 'Text Editor', key: 'A' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Hotkey requires')
    })
    await expect(
      client.action('setValue', { app: 'Text Editor', elementIndex: 0 })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing value')
    })
    expectDesktopProviderSubprocessStartCount(0)
  })

  it('rejects non-keyboard actions that the provider does not advertise', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities({
        setValue: false
      })
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    await expect(
      client.action('setValue', {
        app: 'Text Editor',
        elementIndex: 0,
        value: 'changed',
        noScreenshot: true
      })
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringContaining('actions.setValue')
    })
  })

  it('uses provider action metadata when bridge reports the actual path', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse({
      ok: true,
      action: {
        path: 'accessibility',
        actionName: 'Press',
        fallbackReason: null
      },
      snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    await expect(
      client.action('click', {
        app: 'Text Editor',
        elementIndex: 0,
        noScreenshot: true
      })
    ).resolves.toMatchObject({
      action: {
        path: 'accessibility',
        actionName: 'Press'
      }
    })
  })

  it('explains that missing element indexes require a fresh snapshot', async () => {
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(
      client.action('click', { app: 'Text Editor', elementIndex: 4 })
    ).rejects.toMatchObject({
      code: 'element_not_found',
      message: expect.stringContaining('run get-app-state again')
    })
  })
})
