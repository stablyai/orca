import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const {
  getSpawnArgsForWindowsMock,
  handleMock,
  openPathMock,
  resolveCliCommandMock,
  showItemInFolderMock,
  showOpenDialogMock,
  spawnMock,
  statMock
} = vi.hoisted(() => ({
  getSpawnArgsForWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  openPathMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  spawnMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    showItemInFolder: showItemInFolderMock,
    openExternal: vi.fn(),
    openPath: openPathMock
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  }
}))

vi.mock('node:fs/promises', () => ({
  constants: { COPYFILE_EXCL: 1 },
  copyFile: vi.fn(),
  stat: statMock
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

vi.mock('../win32-utils', () => ({
  getSpawnArgsForWindows: getSpawnArgsForWindowsMock
}))

import { EXTERNAL_EDITOR_CLI_COMMAND, registerShellHandlers } from './shell'

function createSpawnedProcess(result: 'spawn' | 'error' = 'spawn'): {
  once: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
} {
  const child = {
    once: vi.fn((eventName: string, callback: (error?: Error) => void) => {
      if (eventName === result) {
        queueMicrotask(() => {
          callback(result === 'error' ? new Error('launcher unavailable') : undefined)
        })
      }
      return child
    }),
    unref: vi.fn()
  }
  return child
}

describe('registerShellHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    getSpawnArgsForWindowsMock.mockReset()
    openPathMock.mockReset()
    resolveCliCommandMock.mockReset()
    showItemInFolderMock.mockReset()
    showOpenDialogMock.mockReset()
    spawnMock.mockReset()
    statMock.mockReset()
    openPathMock.mockResolvedValue('')
    resolveCliCommandMock.mockReturnValue('editor-cli')
    getSpawnArgsForWindowsMock.mockImplementation((command: string, args: string[]) => ({
      spawnCmd: command,
      spawnArgs: args
    }))
    spawnMock.mockReturnValue(createSpawnedProcess())
    statMock.mockResolvedValue({ isDirectory: () => true })
  })

  function getHandler(channel: string): (event: unknown, args?: unknown) => Promise<unknown> {
    registerShellHandlers()
    const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`${channel} handler not registered`)
    }
    return call[1] as (event: unknown, args?: unknown) => Promise<unknown>
  }

  it('picks audio files with a constrained native dialog filter', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/kaylee/Downloads/Note_block_pling.ogg']
    })

    const handler = getHandler('shell:pickAudio')
    await expect(handler({})).resolves.toBe('/Users/kaylee/Downloads/Note_block_pling.ogg')
    expect(showOpenDialogMock).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
  })

  it('returns null when audio picking is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: true,
      filePaths: []
    })

    const handler = getHandler('shell:pickAudio')
    await expect(handler({})).resolves.toBeNull()
  })

  describe('shell:openInFileManager', () => {
    it('rejects relative paths', async () => {
      const handler = getHandler('shell:openInFileManager')

      await expect(handler({}, 'relative/workspace')).resolves.toEqual({
        ok: false,
        reason: 'not-absolute'
      })
      expect(statMock).not.toHaveBeenCalled()
      expect(showItemInFolderMock).not.toHaveBeenCalled()
    })

    it('rejects missing paths', async () => {
      statMock.mockRejectedValueOnce(new Error('missing'))
      const workspacePath = resolve('missing-workspace')
      const handler = getHandler('shell:openInFileManager')

      await expect(handler({}, workspacePath)).resolves.toEqual({
        ok: false,
        reason: 'not-found'
      })
      expect(statMock).toHaveBeenCalledWith(normalize(workspacePath))
      expect(showItemInFolderMock).not.toHaveBeenCalled()
    })

    it('maps launcher errors to launch-failed', async () => {
      showItemInFolderMock.mockImplementationOnce(() => {
        throw new Error('launcher unavailable')
      })
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInFileManager')

      await expect(handler({}, workspacePath)).resolves.toEqual({
        ok: false,
        reason: 'launch-failed'
      })
      expect(showItemInFolderMock).toHaveBeenCalledWith(normalize(workspacePath))
    })

    it('opens existing absolute paths in the OS file manager', async () => {
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInFileManager')

      await expect(handler({}, workspacePath)).resolves.toEqual({ ok: true })
      expect(showItemInFolderMock).toHaveBeenCalledWith(normalize(workspacePath))
    })
  })

  describe('shell:openInExternalEditor', () => {
    it('rejects relative paths', async () => {
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, 'relative/workspace')).resolves.toEqual({
        ok: false,
        reason: 'not-absolute'
      })
      expect(statMock).not.toHaveBeenCalled()
      expect(openPathMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('rejects missing paths', async () => {
      statMock.mockRejectedValueOnce(new Error('missing'))
      const workspacePath = resolve('missing-workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, workspacePath)).resolves.toEqual({
        ok: false,
        reason: 'not-found'
      })
      expect(statMock).toHaveBeenCalledWith(normalize(workspacePath))
      expect(openPathMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('maps launcher failures to launch-failed', async () => {
      spawnMock.mockReturnValueOnce(createSpawnedProcess('error'))
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, workspacePath)).resolves.toEqual({
        ok: false,
        reason: 'launch-failed'
      })
      expect(resolveCliCommandMock).toHaveBeenCalledWith(EXTERNAL_EDITOR_CLI_COMMAND)
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('editor-cli', [
        normalize(workspacePath)
      ])
      expect(spawnMock).toHaveBeenCalledWith('editor-cli', [normalize(workspacePath)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('opens existing absolute paths with the editor launcher', async () => {
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, workspacePath)).resolves.toEqual({ ok: true })
      expect(resolveCliCommandMock).toHaveBeenCalledWith(EXTERNAL_EDITOR_CLI_COMMAND)
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('editor-cli', [
        normalize(workspacePath)
      ])
      expect(spawnMock).toHaveBeenCalledWith('editor-cli', [normalize(workspacePath)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('uses platform-safe launcher command arguments', async () => {
      getSpawnArgsForWindowsMock.mockReturnValueOnce({
        spawnCmd: 'platform-runner',
        spawnArgs: ['platform-arg']
      })
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, workspacePath)).resolves.toEqual({ ok: true })
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('editor-cli', [
        normalize(workspacePath)
      ])
      expect(spawnMock).toHaveBeenCalledWith('platform-runner', ['platform-arg'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      expect(openPathMock).not.toHaveBeenCalled()
    })
  })

  describe('legacy file open handlers', () => {
    it('does not open relative file paths', async () => {
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, 'relative/file.md')).resolves.toBeUndefined()
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('does not open missing file paths', async () => {
      statMock.mockRejectedValueOnce(new Error('missing'))
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, resolve('missing.md'))).resolves.toBeUndefined()
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('swallows host launcher failures for file paths', async () => {
      openPathMock.mockRejectedValueOnce(new Error('launcher unavailable'))
      const filePath = resolve('note.md')
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, filePath)).resolves.toBeUndefined()
      expect(openPathMock).toHaveBeenCalledWith(normalize(filePath))
    })

    it('does not open non-file URIs', async () => {
      const handler = getHandler('shell:openFileUri')

      await expect(handler({}, 'https://example.com/file.md')).resolves.toBeUndefined()
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('does not open remote file URIs', async () => {
      const handler = getHandler('shell:openFileUri')

      await expect(handler({}, 'file://server/share/file.md')).resolves.toBeUndefined()
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('swallows host launcher failures for file URIs', async () => {
      openPathMock.mockRejectedValueOnce(new Error('launcher unavailable'))
      const filePath = resolve('note.md')
      const handler = getHandler('shell:openFileUri')

      await expect(handler({}, pathToFileURL(filePath).toString())).resolves.toBeUndefined()
      expect(openPathMock).toHaveBeenCalledWith(normalize(filePath))
    })
  })
})
