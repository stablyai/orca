import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {}, webContents: {} }))

const { setTrustedUIRendererWebContentsId } = await import('../ui')
const { handleAppQuitRequest } = await import('./app-quit-request')

function quitRequest({
  id = 7,
  type = 'window',
  fromSubframe = false
}: { id?: number; type?: ReturnType<WebContents['getType']>; fromSubframe?: boolean } = {}) {
  const mainFrame = {}
  const sender = {
    id,
    mainFrame,
    isDestroyed: () => false,
    getType: () => type,
    getURL: () => 'file:///orca/index.html'
  }
  return { sender, senderFrame: fromSubframe ? {} : mainFrame }
}

it('quits only for the trusted app window main frame', () => {
  setTrustedUIRendererWebContentsId(7)
  const quit = vi.fn()

  handleAppQuitRequest(quitRequest({ id: 8 }), quit)
  handleAppQuitRequest(quitRequest({ type: 'webview' }), quit)
  handleAppQuitRequest(quitRequest({ fromSubframe: true }), quit)
  expect(quit).not.toHaveBeenCalled()

  handleAppQuitRequest(quitRequest(), quit)
  expect(quit).toHaveBeenCalledTimes(1)
})
