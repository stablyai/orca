/* eslint-disable max-lines -- Why: desktop provider contract coverage shares one mocked bridge harness. */
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import { DesktopScriptProviderClient } from './desktop-script-provider-client'

vi.mock('child_process', () => ({
  execFile: vi.fn()
}))

describe('DesktopScriptProviderClient', () => {
  it('normalizes list-apps responses', async () => {
    mockBridgeResponse({
      ok: true,
      apps: [{ name: 'Notepad', bundleIdentifier: 'notepad', pid: 42 }]
    })

    const client = new DesktopScriptProviderClient('windows', '/tmp/runtime.ps1')

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
      snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
    })

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

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

    const secondCall = vi.mocked(execFile).mock.calls[1]
    const operationPath = secondCall[1]?.at(-1)
    expect(typeof operationPath).toBe('string')
  })

  it('targets cached elements by session and explicit window id', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
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
          windowId: 99,
          windowIndex: 0,
          fromElement: expect.objectContaining({ index: 0 }),
          toElement: expect.objectContaining({ index: 0 })
        })
        expect(operation.from_x).toBeUndefined()
        expect(operation.to_x).toBeUndefined()
        expect(operation.windowBounds).toBeNull()
      }
    )

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', session: 'agent-a', windowId: 99 })
    await client.action('drag', {
      app: 'Text Editor',
      session: 'agent-a',
      windowId: 99,
      windowIndex: 0,
      fromElementIndex: 0,
      toElementIndex: 0
    })
  })

  it('forwards restore-window to desktop providers', async () => {
    mockBridgeResponse(
      {
        ok: true,
        snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'get_app_state',
          restoreWindow: true
        })
      }
    )
    mockBridgeResponse(
      {
        ok: true,
        snapshot: sampleBridgeSnapshot('Text Editor', 'changed')
      },
      (operation) => {
        expect(operation).toMatchObject({
          tool: 'set_value',
          restoreWindow: true
        })
      }
    )

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await client.snapshot({ app: 'Text Editor', restoreWindow: true })
    const result = await client.action('setValue', {
      app: 'Text Editor',
      elementIndex: 0,
      value: 'changed',
      restoreWindow: true,
      noScreenshot: true
    })

    expect(result.action).toMatchObject({
      path: 'accessibility',
      actionName: 'setValue'
    })
  })

  it('keeps window-index snapshots scoped to the matching session', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
    })
    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

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

  it('explains screenshot capture failures while keeping accessibility state usable', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: {
        ...sampleBridgeSnapshot('Text Editor', 'initial'),
        screenshotPngBase64: null
      }
    })

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

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

  it('normalizes list-windows responses after provider handshake', async () => {
    mockBridgeResponse({
      ok: true,
      capabilities: {
        platform: 'linux',
        provider: 'orca-computer-use-linux',
        providerVersion: '1.0.0',
        protocolVersion: 1,
        supports: {
          apps: { list: true, bundleIds: false, pids: true },
          windows: {
            list: true,
            targetById: true,
            targetByIndex: true,
            focus: false,
            moveResize: false
          },
          observation: {
            screenshot: true,
            annotatedScreenshot: false,
            elementFrames: true,
            ocr: false
          },
          actions: {
            click: true,
            typeText: true,
            pressKey: true,
            hotkey: false,
            pasteText: false,
            scroll: true,
            drag: true,
            setValue: true,
            performAction: true
          },
          surfaces: { menus: false, dialogs: false, dock: false, menubar: false }
        }
      }
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

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.listWindows({ app: 'Text Editor' })).resolves.toMatchObject({
      app: { name: 'Text Editor', bundleId: 'Text Editor', pid: 100 },
      windows: [{ index: 0, id: 99, title: 'Document' }]
    })
  })

  it('maps bridge app errors to RuntimeClientError codes', async () => {
    mockBridgeResponse({ ok: false, error: 'appNotFound("Missing")' })

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Missing' })).rejects.toMatchObject({
      code: 'app_not_found'
    })
  })

  it('maps blocked app bridge errors to a policy error', async () => {
    mockBridgeResponse({ ok: false, error: 'appBlocked("1Password")' })

    const client = new DesktopScriptProviderClient('windows', '/tmp/runtime.ps1')

    await expect(client.snapshot({ app: '1Password' })).rejects.toMatchObject({
      code: 'app_blocked'
    })
  })

  it('maps action-specific bridge errors to actionable codes', async () => {
    mockBridgeResponse({ ok: false, error: 'element value is not settable' })
    mockBridgeResponse({ ok: false, error: 'Raise is not a valid secondary action' })

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'value_not_settable'
    })
    await expect(client.snapshot({ app: 'Text Editor' })).rejects.toMatchObject({
      code: 'action_not_supported'
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

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(
      client.action('pasteText', { app: 'Text Editor', text: 'hello' })
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringContaining('actions.pasteText')
    })
  })

  it('uses provider action metadata when bridge reports the actual path', async () => {
    mockBridgeResponse({
      ok: true,
      snapshot: sampleBridgeSnapshot('Text Editor', 'initial')
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

    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

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
    const client = new DesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(
      client.action('click', { app: 'Text Editor', elementIndex: 4 })
    ).rejects.toMatchObject({
      code: 'element_not_found',
      message: expect.stringContaining('run get-app-state again')
    })
  })
})

function mockBridgeResponse(
  response: unknown,
  inspectOperation?: (operation: Record<string, unknown>) => void
): void {
  vi.mocked(execFile).mockImplementationOnce((_command, _args, _options, callback) => {
    const operationPath = _args?.at(-1)
    if (inspectOperation && typeof operationPath === 'string') {
      inspectOperation(JSON.parse(readFileSync(operationPath, 'utf8')) as Record<string, unknown>)
    }
    const done = callback as (error: Error | null, stdout: string, stderr: string) => void
    done(null, JSON.stringify(response), '')
    return null as never
  })
}

function sampleBridgeSnapshot(name: string, value: string) {
  return {
    app: { name, bundleIdentifier: name, pid: 100 },
    snapshotId: 'snap-test',
    windowTitle: name,
    windowId: 99,
    windowBounds: { x: 10, y: 20, width: 300, height: 200 },
    screenshotPngBase64: 'iVBORw0KGgo=',
    coordinateSpace: 'window',
    truncation: { truncated: false, maxNodes: 1200, maxDepth: 64, maxDepthReached: false },
    treeLines: [`0 text entry area, Value: ${value}`],
    focusedSummary: 'text entry area',
    elements: [
      {
        index: 0,
        runtimeId: [0, 0],
        name: 'Body',
        controlType: 'text',
        localizedControlType: 'text entry area',
        value,
        frame: { x: 1, y: 2, width: 100, height: 20 },
        actions: ['SetValue']
      }
    ]
  }
}

function sampleCapabilities(actions: Partial<Record<string, boolean>> = {}) {
  return {
    platform: 'linux',
    provider: 'orca-computer-use-linux',
    providerVersion: '1.0.0',
    protocolVersion: 1,
    supports: {
      apps: { list: true, bundleIds: false, pids: true },
      windows: {
        list: true,
        targetById: true,
        targetByIndex: true,
        focus: false,
        moveResize: false
      },
      observation: {
        screenshot: true,
        annotatedScreenshot: false,
        elementFrames: true,
        ocr: false
      },
      actions: {
        click: true,
        typeText: true,
        pressKey: true,
        hotkey: true,
        pasteText: true,
        scroll: true,
        drag: true,
        setValue: true,
        performAction: true,
        ...actions
      },
      surfaces: { menus: false, dialogs: false, dock: false, menubar: false }
    }
  }
}

function publicSnapshotKeys(snapshot: unknown): string[] {
  return Object.keys(snapshot as Record<string, unknown>).sort()
}
