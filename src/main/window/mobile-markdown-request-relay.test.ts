import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcEmitter = new EventEmitter()
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({
  ipcMain: ipcMainMock
}))

describe('requestMobileMarkdownFromRenderer', () => {
  beforeEach(() => {
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('ignores markdown responses from other renderer processes', async () => {
    const { requestMobileMarkdownFromRenderer } = await import('./mobile-markdown-request-relay')
    const mainWebContents = {
      send: vi.fn()
    }
    const otherWebContents = {}
    const mainWindow = {
      isDestroyed: () => false,
      webContents: mainWebContents
    }

    const pending = requestMobileMarkdownFromRenderer(mainWindow as never, {
      operation: 'read',
      worktreeId: 'wt-1',
      tabId: 'tab-md'
    })
    const sentRequest = mainWebContents.send.mock.calls[0]?.[1] as { id: string }

    ipcEmitter.emit(
      'ui:mobileMarkdownResponse',
      { sender: otherWebContents },
      { id: sentRequest.id, ok: false, error: 'wrong_renderer' }
    )
    ipcEmitter.emit(
      'ui:mobileMarkdownResponse',
      { sender: mainWebContents },
      {
        id: sentRequest.id,
        ok: true,
        result: {
          tabId: 'tab-md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          content: '# ok',
          isDirty: false,
          version: 'v1',
          source: 'file',
          editable: true
        }
      }
    )

    await expect(pending).resolves.toMatchObject({ content: '# ok' })
  })
})
