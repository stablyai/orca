import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  publicSnapshotKeys,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient snapshots', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('normalizes list-apps responses', async () => {
    mockBridgeResponse({
      ok: true,
      apps: [{ name: 'Notepad', bundleIdentifier: 'notepad', pid: 42 }]
    })

    const client = await createDesktopScriptProviderClient('windows', '/tmp/runtime.ps1')

    await expect(client.listApps()).resolves.toEqual({
      apps: [
        {
          name: 'Notepad',
          bundleId: 'notepad',
          pid: 42,
          isRunning: true,
          lastUsedAt: null,
          useCount: null
        }
      ]
    })
  })

  it('normalizes snapshots and remembers elements for follow-up actions', async () => {
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
      snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    const initial = await client.snapshot({ app: 'Text Editor' })
    expect(initial.snapshot.elementCount).toBe(1)
    expect(initial.snapshot.window).toMatchObject({
      title: 'Text Editor',
      id: 99,
      x: 10,
      y: 20,
      width: 300,
      height: 200
    })
    expect(initial.screenshotStatus).toEqual({
      state: 'captured',
      metadata: { engine: 'unknown', windowId: 99 }
    })
    expect(initial.snapshot.treeText).toContain('initial')
    expect(publicSnapshotKeys(initial.snapshot)).toEqual([
      'app',
      'coordinateSpace',
      'elementCount',
      'focusedElementId',
      'id',
      'treeText',
      'truncation',
      'window'
    ])

    await client.action('setValue', {
      app: 'Text Editor',
      elementIndex: 0,
      value: 'changed',
      noScreenshot: true
    })
  })

  it('uses bridge screenshot dimensions when the native payload is downscaled', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        screenshotWidth: 150,
        screenshotHeight: 100,
        screenshotScale: 0.5
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    const result = await client.snapshot({ app: 'Text Editor' })

    expect(result.screenshot).toEqual({
      data: 'iVBORw0KGgo=',
      format: 'png',
      width: 150,
      height: 100,
      scale: 0.5
    })
    expect(result.snapshot.window).toMatchObject({
      width: 300,
      height: 200
    })
  })

  it('preserves provider window indexes when the snapshot has no stable window id', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        windowId: null,
        windowIndex: 3
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    const result = await client.snapshot({ app: 'Text Editor', windowIndex: 3 })

    expect(result.snapshot.window).toMatchObject({
      id: null,
      index: 3,
      title: 'Text Editor'
    })
  })

  it('uses window indexes in fallback snapshot IDs for ID-less provider windows', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'first'),
        snapshotId: undefined,
        windowId: null,
        windowIndex: 1
      }
    })
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'second'),
        snapshotId: undefined,
        windowId: null,
        windowIndex: 2
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    const first = await client.snapshot({ app: 'Text Editor', windowIndex: 1 })
    const second = await client.snapshot({ app: 'Text Editor', windowIndex: 2 })

    expect(first.snapshot.id).toContain('window-index:1')
    expect(second.snapshot.id).toContain('window-index:2')
    expect(first.snapshot.id).not.toBe(second.snapshot.id)
  })

  it('adds target window index metadata for ID-less action results', async () => {
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
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'changed'),
        windowId: null,
        windowIndex: 3
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', windowIndex: 3 })
    const result = await client.action('click', {
      app: 'Text Editor',
      windowIndex: 3,
      elementIndex: 0,
      noScreenshot: true
    })

    expect(result.action).toMatchObject({
      targetWindowId: null,
      targetWindowIndex: 3
    })
  })
})
