import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient paste validation', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('yields while validating large accepted pasteText payloads before launching the provider', async () => {
    vi.useFakeTimers()
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse({
      ok: true,
      action: {
        path: 'clipboard',
        actionName: 'paste',
        fallbackReason: null
      },
      snapshot: sampleBridgeSnapshot('Text Editor', 'pasted')
    })
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    const call = client.action('pasteText', {
      app: 'Text Editor',
      text,
      noScreenshot: true
    })
    await Promise.resolve()

    expectDesktopProviderSubprocessStartCount(0)

    await vi.advanceTimersByTimeAsync(0)
    await expect(call).resolves.toMatchObject({
      action: { path: 'clipboard' }
    })
    expectDesktopProviderSubprocessStartCount(2)
  })
})
