import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient actions', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('marks set-value unverified when the refreshed snapshot does not contain the requested value', async () => {
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
      snapshot: sampleBridgeSnapshot('Text Editor', 'unchanged')
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
      path: 'accessibility',
      actionName: 'setValue',
      verification: {
        state: 'unverified',
        reason: 'value_mismatch',
        expected: 'changed',
        actualPreview: 'unchanged'
      }
    })
  })

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

  it('keeps window-index snapshots scoped to the matching session', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', session: 'agent-a', windowIndex: 0 })

    await expect(
      client.action('click', {
        app: 'Text Editor',
        session: 'agent-b',
        windowIndex: 0,
        elementIndex: 0
      })
    ).rejects.toMatchObject({ code: 'element_not_found' })
  })

  it('expires cached desktop snapshots before using old element indexes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-04T12:00:00.000Z'))
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    await vi.advanceTimersByTimeAsync(120_001)

    await expect(
      client.action('click', { app: 'Text Editor', elementIndex: 0, noScreenshot: true })
    ).rejects.toMatchObject({
      code: 'element_not_found',
      message: expect.stringContaining('fresh element index')
    })
    expectDesktopProviderSubprocessStartCount(1)
  })
})
