import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient action errors', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

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
      client.action('click', { app: 'Text Editor', elementIndex: 0, mouseButton: 'wheel' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Unsupported mouseButton')
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
      client.action('pasteText', {
        app: 'Text Editor',
        text: ['native-provider-secret', 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)].join('')
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
    })
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
})
