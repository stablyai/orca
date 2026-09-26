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
  window: Parameters<typeof installWorkspaceWindowMetadataListener>[0]
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
    },
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
      { displayName: 'stevie-vs-orca', repoName: 'orca', localPath: '/tmp/orca/worktree' }
    )
    expect(setRepresentedFilename).toHaveBeenLastCalledWith('/tmp/orca/worktree')
    expect(setTitle).toHaveBeenLastCalledWith('stevie-vs-orca — orca — Orca: local-dev')

    listener({ sender: { id: 42 } }, { displayName: null, localPath: null })
    expect(setRepresentedFilename).toHaveBeenLastCalledWith('')
    expect(setTitle).toHaveBeenLastCalledWith('Orca: local-dev')

    dispose()
    expect(ipcMainRemoveListenerMock).toHaveBeenCalledWith(
      WORKSPACE_WINDOW_METADATA_CHANNEL,
      listener
    )
  })

  it.each([
    { displayName: 'main', repoName: 'orca', title: 'main — orca — Orca' },
    { displayName: 'orca', repoName: 'orca', title: 'orca — Orca' },
    { displayName: 'Notes', repoName: undefined, title: 'Notes — Orca' },
    {
      displayName: 'remote-task',
      repoName: 'remote-repo',
      title: 'remote-task — remote-repo — Orca'
    },
    { displayName: null, repoName: 'orca', title: 'Orca' }
  ])('formats the window title as $title', ({ displayName, repoName, title }) => {
    const { window, setTitle, setRepresentedFilename } = createWindow()
    installWorkspaceWindowMetadataListener(window, 'Orca', 'darwin')
    const listener = ipcMainOnMock.mock.calls[0]?.[1]

    listener({ sender: { id: 42 } }, { displayName, repoName, localPath: null })

    expect(setTitle).toHaveBeenLastCalledWith(title)
    expect(setRepresentedFilename).toHaveBeenLastCalledWith('')
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
        repoName: '  repo  ',
        localPath: '/Users/example/workspace'
      })
    ).toEqual({ displayName: 'workspace', repoName: 'repo', localPath: '/Users/example/workspace' })
    expect(
      normalizeWorkspaceWindowMetadata({ displayName: '', localPath: 'relative/workspace' })
    ).toEqual({ displayName: null, repoName: null, localPath: null })
    expect(
      normalizeWorkspaceWindowMetadata({ displayName: 42, localPath: '/tmp/bad\0path' })
    ).toEqual({ displayName: null, repoName: null, localPath: null })
    expect(
      normalizeWorkspaceWindowMetadata({
        displayName: 'x'.repeat(513),
        localPath: `/${'x'.repeat(32_768)}`
      })
    ).toEqual({ displayName: null, repoName: null, localPath: null })
  })

  it.each([undefined, null, '', 42, 'x'.repeat(513)])(
    'ignores missing or invalid repository names without losing workspace metadata',
    (repoName) => {
      expect(
        normalizeWorkspaceWindowMetadata({
          displayName: 'workspace',
          repoName,
          localPath: '/tmp/workspace'
        })
      ).toEqual({ displayName: 'workspace', repoName: null, localPath: '/tmp/workspace' })
    }
  )
})
