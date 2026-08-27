import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL,
  BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL,
  type BrowserClientPageRendererRequest
} from '../../shared/browser-client-page-renderer-protocol'

const { ipcMainOn, ipcMainRemoveListener } = vi.hoisted(() => ({
  ipcMainOn: vi.fn(),
  ipcMainRemoveListener: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: ipcMainOn,
    removeListener: ipcMainRemoveListener
  }
}))

import {
  attachBrowserClientPageRenderer,
  retireBrowserClientPageRenderer,
  selectBrowserClientPageRenderer
} from './browser-client-page-renderer-runtime'

describe('browser client page renderer runtime', () => {
  it('lazily binds the app-lifetime IPC listener and exact current Electron renderer', async () => {
    expect(ipcMainOn).not.toHaveBeenCalled()
    const rendererEndpoint = {
      id: 41,
      mainFrame: {},
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
    attachBrowserClientPageRenderer(rendererEndpoint)
    const listener = ipcMainOn.mock.calls.find(
      ([channel]) => channel === BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL
    )?.[1]
    expect(listener).toEqual(expect.any(Function))

    const renderer = selectBrowserClientPageRenderer()
    const mounted = renderer.mountPage(
      {
        partition: 'persist:orca-browser-route:v1:partition-a',
        browserPageId: 'page-a',
        pageHostGeneration: 7
      },
      new AbortController().signal
    )
    const request = rendererEndpoint.send.mock.calls[0]?.[1] as BrowserClientPageRendererRequest
    expect(rendererEndpoint.send).toHaveBeenCalledWith(
      BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL,
      expect.objectContaining({ type: 'mountPage' })
    )

    listener?.(
      { sender: rendererEndpoint, senderFrame: rendererEndpoint.mainFrame },
      {
        type: 'mounted',
        requestId: request.requestId,
        page: request.page,
        webContentsId: 91
      }
    )
    await expect(mounted).resolves.toEqual({ webContentsId: 91 })

    expect(retireBrowserClientPageRenderer(rendererEndpoint)).toBe(true)
    expect(selectBrowserClientPageRenderer).toThrow('browser_client_page_renderer_unavailable')
  })
})
