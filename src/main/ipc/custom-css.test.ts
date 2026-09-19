import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomCssSnapshot } from '../../shared/custom-css'
import type { CustomCssHandlerService } from './custom-css'

const { appOnceMock, authorizeExternalPathMock, handleMock, openPathMock, showItemInFolderMock } =
  vi.hoisted(() => ({
    appOnceMock: vi.fn(),
    authorizeExternalPathMock: vi.fn(),
    handleMock: vi.fn(),
    openPathMock: vi.fn(),
    showItemInFolderMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Users/example'), once: appOnceMock },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: handleMock },
  shell: { openPath: openPathMock, showItemInFolder: showItemInFolderMock }
}))

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock
}))

import { registerCustomCssHandlers } from './custom-css'

const snapshot: CustomCssSnapshot = {
  path: '/Users/example/.orca/custom.css',
  exists: true,
  css: '',
  error: null
}

function createService(): CustomCssHandlerService {
  return {
    getSnapshot: vi.fn(() => snapshot),
    ensureFile: vi.fn(() => snapshot),
    dispose: vi.fn()
  }
}

function getHandler(channel: string): () => unknown {
  const call = handleMock.mock.calls.find(([registered]) => registered === channel)
  if (!call) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return () => call[1]()
}

describe('registerCustomCssHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('authorizes custom.css before opening it outside Orca', async () => {
    openPathMock.mockResolvedValue('')
    const service = createService()
    registerCustomCssHandlers(service)

    await expect(getHandler('customCss:openFile')()).resolves.toBe(snapshot)
    expect(service.ensureFile).toHaveBeenCalledOnce()
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(snapshot.path)
    expect(openPathMock).toHaveBeenCalledWith(snapshot.path)
  })

  it('creates and authorizes the file before revealing it', () => {
    const service = createService()
    registerCustomCssHandlers(service)

    expect(getHandler('customCss:revealFile')()).toBe(snapshot)
    expect(service.ensureFile).toHaveBeenCalledOnce()
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(snapshot.path)
    expect(showItemInFolderMock).toHaveBeenCalledWith(snapshot.path)
  })

  it('reads without creating the file, and stops watching on quit', () => {
    const service = createService()
    registerCustomCssHandlers(service)

    expect(getHandler('customCss:get')()).toBe(snapshot)
    expect(service.ensureFile).not.toHaveBeenCalled()

    const [event, onQuit] = appOnceMock.mock.calls[0]
    expect(event).toBe('will-quit')
    onQuit()
    expect(service.dispose).toHaveBeenCalledOnce()
  })
})
