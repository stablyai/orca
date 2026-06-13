import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient snapshot cache', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('targets cached ID-less snapshots by their provider window index on follow-up actions', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        windowId: null,
        windowIndex: 3
      }
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: {
          ...sampleBridgeSnapshot('Text Editor', 'changed'),
          windowId: null,
          windowIndex: 3
        }
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'set_value',
          app: 'Text Editor',
          windowIndex: 3,
          element: expect.objectContaining({ index: 0 })
        })
        expect(operation.windowId).toBeUndefined()
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    await client.action('setValue', {
      app: 'Text Editor',
      elementIndex: 0,
      value: 'changed',
      noScreenshot: true
    })
  })

  it('aliases provider window indexes for explicit follow-up actions after an ID-less snapshot', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        windowId: null,
        windowIndex: 3
      }
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: {
          ...sampleBridgeSnapshot('Text Editor', 'changed'),
          windowId: null,
          windowIndex: 3
        }
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'set_value',
          windowIndex: 3,
          element: expect.objectContaining({ index: 0 })
        })
        expect(operation.windowId).toBeUndefined()
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    await client.action('setValue', {
      app: 'Text Editor',
      windowIndex: 3,
      elementIndex: 0,
      value: 'changed',
      noScreenshot: true
    })
  })

  it('aliases cached snapshots by documented pid selector for follow-up actions', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'set_value',
          app: 'pid:100',
          windowId: 99,
          element: expect.objectContaining({ index: 0 })
        })
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })
    await client.action('setValue', {
      app: 'pid:100',
      elementIndex: 0,
      value: 'changed',
      noScreenshot: true
    })
  })

  it('aliases cached window-index snapshots by documented pid selector', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        windowId: null,
        windowIndex: 3
      }
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: {
          ...sampleBridgeSnapshot('Text Editor', 'changed'),
          windowId: null,
          windowIndex: 3
        }
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'set_value',
          app: 'pid:100',
          windowIndex: 3,
          element: expect.objectContaining({ index: 0 })
        })
        expect(operation.windowId).toBeUndefined()
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', windowIndex: 3 })
    await client.action('setValue', {
      app: 'pid:100',
      windowIndex: 3,
      elementIndex: 0,
      value: 'changed',
      noScreenshot: true
    })
  })

  it('does not alias cached snapshots by invalid provider pids', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        app: { name: 'Text Editor', bundleIdentifier: 'Text Editor', pid: 0 }
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor' })

    const cacheKeys = [
      ...(client as unknown as { snapshots: Map<string, unknown> }).snapshots.keys()
    ]
    expect(cacheKeys).not.toContain('pid:0')
    expect(cacheKeys).not.toContain('default:pid:0')
    expect(cacheKeys).not.toContain('0')
    expect(cacheKeys).not.toContain('default:0')
  })

  it('drops focused element ids that are not present in the rendered element records', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        focusedElementId: 99
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    const result = await client.snapshot({ app: 'Text Editor' })

    expect(result.snapshot.focusedElementId).toBeNull()
  })

  it('does not retain screenshot bytes in the follow-up action cache', async () => {
    const largeScreenshot = 'x'.repeat(1024 * 1024)
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        screenshotPngBase64: largeScreenshot
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    const result = await client.snapshot({ app: 'Text Editor' })
    const cached = [
      ...(
        client as unknown as { snapshots: Map<string, { screenshotPngBase64?: string | null }> }
      ).snapshots.values()
    ]

    expect(result.screenshot?.data).toBe(largeScreenshot)
    expect(cached.length).toBeGreaterThan(0)
    expect(cached.every((snapshot) => snapshot.screenshotPngBase64 === null)).toBe(true)
  })

  it('targets cached elements by session and window id after observe without a window selector', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'click',
          app: 'Text Editor',
          windowId: 99,
          element: expect.objectContaining({ index: 0 })
        })
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', session: 'agent-a' })
    await client.action('click', {
      app: 'Text Editor',
      session: 'agent-a',
      windowId: 99,
      elementIndex: 0,
      noScreenshot: true
    })
  })

  it('targets cached elements by session and explicit window index without forwarding window id', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'drag',
          app: 'Text Editor',
          windowIndex: 0,
          fromElement: expect.objectContaining({ index: 0 }),
          toElement: expect.objectContaining({ index: 0 })
        })
        expect(operation.windowId).toBeUndefined()
        expect(operation.from_x).toBeUndefined()
        expect(operation.to_x).toBeUndefined()
        expect(operation.windowBounds).toBeNull()
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', session: 'agent-a', windowIndex: 0 })
    await client.action('drag', {
      app: 'Text Editor',
      session: 'agent-a',
      windowIndex: 0,
      fromElementIndex: 0,
      toElementIndex: 0
    })
  })
})
