import { describe, expect, it, vi } from 'vitest'
import type { HostSessionBrowserOperations } from '../session/host-session-browser-operations'
import { createMobileBrowserRpcClient } from './mobile-browser-rpc-client'

function operations(): HostSessionBrowserOperations {
  return {
    subscribe: vi.fn(() => () => undefined),
    navigate: vi.fn(async () => ({ url: 'https://example.test/' })),
    scroll: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    insertText: vi.fn(async () => undefined),
    keypress: vi.fn(async () => undefined),
    dialog: vi.fn(async () => undefined),
    back: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined)
  }
}

describe('mobile browser RPC adapter', () => {
  it('maps commands to an opaque workspace/page target', async () => {
    const ops = operations()
    const client = createMobileBrowserRpcClient(ops)

    await expect(
      client.sendRequest('browser.goto', {
        worktree: 'id:workspace-1',
        page: 'page-1',
        url: 'https://example.test'
      })
    ).resolves.toMatchObject({ ok: true, result: { url: 'https://example.test/' } })
    expect(ops.navigate).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', pageId: 'page-1' },
      'https://example.test'
    )
  })

  it('returns a success sentinel for atomic clicks', async () => {
    const ops = operations()
    const client = createMobileBrowserRpcClient(ops)
    const response = await client.sendRequest('browser.mouseClick', {
      worktree: 'id:workspace-1',
      page: 'page-1',
      x: 10,
      y: 20,
      button: 'left',
      modifiers: ['shift'],
      radius: 14
    })

    expect(response).toMatchObject({ ok: true, result: { clicked: true } })
    expect(ops.click).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', pageId: 'page-1' },
      { x: 10, y: 20 },
      'left',
      ['shift'],
      14
    )
  })

  it('tracks pointer position for wheel commands and forwards stream events', async () => {
    const ops = operations()
    const unsubscribe = vi.fn()
    const frame = { image: new Uint8Array([1]), format: 'jpeg' as const, metadata: {} }
    vi.mocked(ops.subscribe).mockImplementation((_target, _request, listener) => {
      listener.onEvent({
        type: 'navigation',
        tab: {
          url: 'https://example.test/',
          title: 'Example',
          canGoBack: true,
          canGoForward: false
        }
      })
      listener.onFrame(frame)
      return unsubscribe
    })
    const client = createMobileBrowserRpcClient(ops)
    const events: unknown[] = []
    const onBinaryFrame = vi.fn()

    const stop = client.subscribe(
      'browser.screencast',
      { worktree: 'id:workspace-1', page: 'page-1', width: 320 },
      (event) => events.push(event),
      { onBinaryFrame }
    )
    await client.sendRequest('browser.mouseMove', {
      worktree: 'id:workspace-1',
      page: 'page-1',
      x: 40,
      y: 50
    })
    await client.sendRequest('browser.mouseWheel', {
      worktree: 'id:workspace-1',
      page: 'page-1',
      dy: 120
    })

    expect(events).toEqual([
      {
        type: 'navigation',
        tab: {
          url: 'https://example.test/',
          title: 'Example',
          canGoBack: true,
          canGoForward: false
        }
      }
    ])
    expect(onBinaryFrame).toHaveBeenCalledWith(frame)
    expect(ops.scroll).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', pageId: 'page-1' },
      { x: 40, y: 50 },
      { dx: 0, dy: 120 }
    )
    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
