import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from '../desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient actions', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('verifies set-value against the same element when refreshed indexes shift', async () => {
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
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'ignored'),
        treeLines: ['0 text entry area, Value: other', '7 text entry area, Value: changed'],
        elements: [
          {
            index: 0,
            runtimeId: [9, 9],
            value: 'other'
          },
          {
            index: 7,
            runtimeId: [0, 0],
            value: 'changed'
          }
        ]
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    const result = await client.action('setValue', {
      app: 'Text Editor',
      elementIndex: 0,
      value: 'changed',
      noScreenshot: true
    })

    expect(result.action).toMatchObject({
      verification: {
        state: 'verified',
        property: 'value',
        expected: 'changed',
        actualPreview: 'changed'
      }
    })
  })
})
