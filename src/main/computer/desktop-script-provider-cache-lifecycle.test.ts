import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopScriptProviderClient,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleBridgeSnapshot,
  sampleCapabilities
} from './desktop-script-provider-test-harness'

describe('DesktopScriptProviderClient cache lifecycle', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('invalidates stale window selector aliases after a window-changed action fallback', async () => {
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
        path: 'synthetic',
        actionName: 'click',
        fallbackReason: null,
        verification: { state: 'unverified', reason: 'window_changed' }
      },
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'fallback'),
        windowId: 123,
        windowTitle: 'Fallback Window'
      }
    })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', session: 'agent-a', windowIndex: 0 })
    await client.action('click', {
      app: 'Text Editor',
      session: 'agent-a',
      windowIndex: 0,
      elementIndex: 0,
      noScreenshot: true
    })

    await expect(
      client.action('click', {
        app: 'Text Editor',
        session: 'agent-a',
        windowIndex: 0,
        elementIndex: 0,
        noScreenshot: true
      })
    ).rejects.toMatchObject({ code: 'element_not_found' })
    const cached = (client as unknown as { snapshots: Map<string, { windowId?: number | null }> })
      .snapshots
    expect(cached.get('session:agent-a:text editor#window-index:0')).toBeUndefined()
    expect(cached.get('session:agent-a:text editor')?.windowId).toBe(123)
  })

  it('bounds cached desktop snapshots while keeping recent aliases usable', async () => {
    const snapshotCount = 40
    for (let index = 0; index < snapshotCount; index++) {
      mockBridgeResponse({
        ok: true,
        snapshot: {
          ...sampleBridgeSnapshot(`App ${index}`, `value ${index}`),
          snapshotId: `snap-${index}`,
          app: { name: `App ${index}`, bundleIdentifier: `bundle.${index}`, pid: 100 + index },
          windowId: 1_000 + index,
          windowTitle: `Window ${index}`
        }
      })
    }
    mockBridgeResponse({
      ok: true,
      capabilities: sampleCapabilities()
    })
    mockBridgeResponse(
      {
        ok: true,
        snapshot: sampleBridgeSnapshot('App 39', 'clicked')
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'click',
          app: 'App 39',
          element: expect.objectContaining({ index: 0 })
        })
      }
    )

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    for (let index = 0; index < snapshotCount; index++) {
      await client.snapshot({ app: `App ${index}` })
    }

    await expect(client.action('click', { app: 'App 0', elementIndex: 0 })).rejects.toMatchObject({
      code: 'element_not_found'
    })
    await expect(
      client.action('click', { app: 'App 39', elementIndex: 0, noScreenshot: true })
    ).resolves.toMatchObject({ snapshot: { app: { name: 'App 39' } } })
  })
})
