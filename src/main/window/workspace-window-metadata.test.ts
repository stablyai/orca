import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_WINDOW_METADATA_CHANNEL } from '../../shared/workspace-window-metadata'

const { ipcMainOnMock, ipcMainRemoveListenerMock } = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: ipcMainOnMock,
    removeListener: ipcMainRemoveListenerMock
  }
}))

import {
  installWorkspaceWindowMetadataListener,
  normalizeWorkspaceWindowMetadata
} from './workspace-window-metadata'

function createWindow(): {
  window: Electron.BrowserWindow
  setRepresentedFilename: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
} {
  const setRepresentedFilename = vi.fn()
  const setTitle = vi.fn()
  return {
    window: {
      webContents: { id: 42 },
      isDestroyed: vi.fn(() => false),
      setRepresentedFilename,
      setTitle
    } as unknown as Electron.BrowserWindow,
    setRepresentedFilename,
    setTitle
  }
}

describe('workspace window metadata', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    ipcMainRemoveListenerMock.mockReset()
  })

  it('updates macOS document metadata only for the owning renderer', () => {
    const { window, setRepresentedFilename, setTitle } = createWindow()
    const dispose = installWorkspaceWindowMetadataListener(window, 'Orca: local-dev', 'darwin')
    const listener = ipcMainOnMock.mock.calls[0]?.[1]

    expect(ipcMainOnMock).toHaveBeenCalledWith(
      WORKSPACE_WINDOW_METADATA_CHANNEL,
      expect.any(Function)
    )

    listener({ sender: { id: 99 } }, { displayName: 'ignored', localPath: '/tmp/ignored' })
    expect(setTitle).not.toHaveBeenCalled()

    listener(
      { sender: { id: 42 } },
      { displayName: 'stevie-vs-orca', localPath: '/tmp/orca/worktree' }
    )
    expect(setRepresentedFilename).toHaveBeenLastCalledWith('/tmp/orca/worktree')
    expect(setTitle).toHaveBeenLastCalledWith('stevie-vs-orca — Orca: local-dev')

    listener({ sender: { id: 42 } }, { displayName: null, localPath: null })
    expect(setRepresentedFilename).toHaveBeenLastCalledWith('')
    expect(setTitle).toHaveBeenLastCalledWith('Orca: local-dev')

    dispose()
    expect(ipcMainRemoveListenerMock).toHaveBeenCalledWith(
      WORKSPACE_WINDOW_METADATA_CHANNEL,
      listener
    )
  })

  it('does not install native metadata handling on other platforms', () => {
    const { window } = createWindow()
    const dispose = installWorkspaceWindowMetadataListener(window, 'Orca', 'linux')

    expect(ipcMainOnMock).not.toHaveBeenCalled()
    dispose()
    expect(ipcMainRemoveListenerMock).not.toHaveBeenCalled()
  })

  it('bounds labels and accepts only absolute, null-free paths', () => {
    expect(
      normalizeWorkspaceWindowMetadata({
        displayName: '  workspace  ',
        localPath: '/Users/example/workspace'
      })
    ).toEqual({ displayName: 'workspace', localPath: '/Users/example/workspace' })
    expect(
      normalizeWorkspaceWindowMetadata({ displayName: '', localPath: 'relative/workspace' })
    ).toEqual({ displayName: null, localPath: null })
    expect(
      normalizeWorkspaceWindowMetadata({ displayName: 42, localPath: '/tmp/bad\0path' })
    ).toEqual({ displayName: null, localPath: null })
    expect(
      normalizeWorkspaceWindowMetadata({
        displayName: 'x'.repeat(513),
        localPath: `/${'x'.repeat(32_768)}`
      })
    ).toEqual({ displayName: null, localPath: null })
  })
})
