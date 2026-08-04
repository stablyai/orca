import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS } from '../../shared/browser-javascript-dialog'

const { handleMock, getJavaScriptDialogMock, respondToJavaScriptDialogMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getJavaScriptDialogMock: vi.fn(),
  respondToJavaScriptDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: handleMock
  },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../browser/browser-manager', () => ({
  browserCertificateTrustController: { proceed: vi.fn() },
  browserManager: {
    getJavaScriptDialog: getJavaScriptDialogMock,
    respondToJavaScriptDialog: respondToJavaScriptDialogMock
  }
}))

import { registerBrowserHandlers } from './browser'

function sender(type: 'window' | 'webview' = 'window'): Electron.WebContents {
  return {
    id: type === 'window' ? 91 : 92,
    isDestroyed: () => false,
    getType: () => type,
    getURL: () => (type === 'window' ? 'file:///renderer/index.html' : 'https://example.com')
  } as Electron.WebContents
}

function getHandler(
  channel: string
): (event: { sender: Electron.WebContents }, args: object) => unknown {
  const handler = handleMock.mock.calls.find(([candidate]) => candidate === channel)?.[1]
  if (!handler) {
    throw new Error(`Missing IPC handler: ${channel}`)
  }
  return handler
}

describe('browser JavaScript dialog IPC', () => {
  beforeEach(() => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    handleMock.mockReset()
    getJavaScriptDialogMock.mockReset()
    respondToJavaScriptDialogMock.mockReset()
    registerBrowserHandlers()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('routes reads and responses through the owning renderer', () => {
    const pendingDialog = {
      browserPageId: 'page-1',
      dialogId: 'dialog-1',
      dialogType: 'confirm',
      message: 'Continue?',
      defaultPromptText: '',
      origin: 'https://example.com'
    }
    getJavaScriptDialogMock.mockReturnValue(pendingDialog)
    respondToJavaScriptDialogMock.mockReturnValue(true)
    const trustedSender = sender()

    expect(
      getHandler('browser:getJavaScriptDialog')(
        { sender: trustedSender },
        { browserPageId: 'page-1' }
      )
    ).toEqual(pendingDialog)
    expect(getJavaScriptDialogMock).toHaveBeenCalledWith('page-1', 91)

    const response = {
      browserPageId: 'page-1',
      dialogId: 'dialog-1',
      accept: true,
      promptText: 'Approved'
    }
    expect(getHandler('browser:respondJavaScriptDialog')({ sender: trustedSender }, response)).toBe(
      true
    )
    expect(respondToJavaScriptDialogMock).toHaveBeenCalledWith(response, 91)
  })

  it('rejects oversized responses', () => {
    const result = getHandler('browser:respondJavaScriptDialog')(
      { sender: sender() },
      {
        browserPageId: 'page-1',
        dialogId: 'dialog-1',
        accept: true,
        promptText: 'x'.repeat(BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS + 1)
      }
    )

    expect(result).toBe(false)
    expect(respondToJavaScriptDialogMock).not.toHaveBeenCalled()
  })

  it('rejects reads and responses from untrusted renderers', () => {
    const untrustedSender = sender('webview')

    expect(
      getHandler('browser:getJavaScriptDialog')(
        { sender: untrustedSender },
        { browserPageId: 'page-1' }
      )
    ).toBeNull()
    expect(
      getHandler('browser:respondJavaScriptDialog')(
        { sender: untrustedSender },
        { browserPageId: 'page-1', dialogId: 'dialog-1', accept: false }
      )
    ).toBe(false)
    expect(getJavaScriptDialogMock).not.toHaveBeenCalled()
    expect(respondToJavaScriptDialogMock).not.toHaveBeenCalled()
  })
})
