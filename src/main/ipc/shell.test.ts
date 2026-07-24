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
  getCmdExePath: () => 'C:\\Windows\\System32\\cmd.exe',
  getSpawnArgsForWindows: getSpawnArgsForWindowsMock
}))

import { EXTERNAL_EDITOR_CLI_COMMAND, registerShellHandlers } from './shell'
import { resolveExternalEditorLaunchSpec } from '../external-editor-launch'
import type { SshTarget } from '../../shared/ssh-types'

function createSpawnedProcess(result: 'spawn' | 'error' = 'spawn'): {
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
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
    off: vi.fn(() => child),
    unref: vi.fn()
  }
  return child
}

function createSshTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-1',
    label: 'Builder',
    host: 'builder.example.com',
    port: 22,
    username: 'ada',
    source: 'ssh-config',
    configHost: 'builder',
    ...overrides
  }
}

describe('registerShellHandlers', () => {
  const settings = { activeRuntimeEnvironmentId: null as string | null }
  const sshTargets = new Map<string, SshTarget>()
  const store = {
    getSettings: () => settings,
    getSshTarget: (id: string) => sshTargets.get(id)
  }

  beforeEach(() => {
    handleMock.mockReset()
    getSpawnArgsForWindowsMock.mockReset()
    openPathMock.mockReset()
    resolveCliCommandMock.mockReset()
    showItemInFolderMock.mockReset()
    showOpenDialogMock.mockReset()
    spawnMock.mockReset()
    statMock.mockReset()
    settings.activeRuntimeEnvironmentId = null
    sshTargets.clear()
    openPathMock.mockResolvedValue('')
    resolveCliCommandMock.mockReturnValue('editor-cli')
    getSpawnArgsForWindowsMock.mockImplementation((command: string, args: string[]) => ({
      spawnCmd: command,
      spawnArgs: args
    }))
    spawnMock.mockReturnValue(createSpawnedProcess())
    statMock.mockResolvedValue({ isDirectory: () => true })
  })

  function getHandler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
    registerShellHandlers(store as never)
    const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`${channel} handler not registered`)
    }
    return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>
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

  it('picks an existing directory without enabling native directory creation', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/kaylee/projects']
    })

    const handler = getHandler('shell:pickDirectory')
    await expect(handler({}, { defaultPath: '/Users/kaylee' })).resolves.toBe(
      '/Users/kaylee/projects'
    )
    expect(showOpenDialogMock).toHaveBeenCalledWith({
      defaultPath: '/Users/kaylee',
      properties: ['openDirectory']
    })
  })

  describe('shell:openPath', () => {
    it('ignores relative paths', async () => {
      const handler = getHandler('shell:openPath')

      await expect(handler({}, 'relative/workspace')).resolves.toBeUndefined()
      expect(statMock).not.toHaveBeenCalled()
      expect(showItemInFolderMock).not.toHaveBeenCalled()
    })

    it('ignores missing paths', async () => {
      statMock.mockRejectedValueOnce(new Error('missing'))
      const workspacePath = resolve('missing-workspace')
      const handler = getHandler('shell:openPath')

      await expect(handler({}, workspacePath)).resolves.toBeUndefined()
      expect(statMock).toHaveBeenCalledWith(normalize(workspacePath))
      expect(showItemInFolderMock).not.toHaveBeenCalled()
    })

    it('reveals existing absolute paths', async () => {
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openPath')

      await expect(handler({}, workspacePath)).resolves.toBeUndefined()
      expect(showItemInFolderMock).toHaveBeenCalledWith(normalize(workspacePath))
    })

    it('swallows launcher failures', async () => {
      showItemInFolderMock.mockImplementationOnce(() => {
        throw new Error('launcher unavailable')
      })
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openPath')

      await expect(handler({}, workspacePath)).resolves.toBeUndefined()
      expect(showItemInFolderMock).toHaveBeenCalledWith(normalize(workspacePath))
    })
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

      await expect(handler({}, { path: 'relative/workspace' })).resolves.toEqual({
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

      await expect(handler({}, { path: workspacePath })).resolves.toEqual({
        ok: false,
        reason: 'not-found'
      })
      expect(statMock).toHaveBeenCalledWith(normalize(workspacePath))
      expect(openPathMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('maps launcher failures to launch-failed', async () => {
      const child = createSpawnedProcess('error')
      spawnMock.mockReturnValueOnce(child)
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: workspacePath })).resolves.toEqual({
        ok: false,
        reason: 'launch-failed'
      })
      expect(resolveCliCommandMock).toHaveBeenCalledWith(EXTERNAL_EDITOR_CLI_COMMAND, {
        platform: process.platform
      })
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('editor-cli', [
        normalize(workspacePath)
      ])
      expect(spawnMock).toHaveBeenCalledWith('editor-cli', [normalize(workspacePath)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      expect(child.off).toHaveBeenCalledWith('error', expect.any(Function))
      expect(child.off).toHaveBeenCalledWith('spawn', expect.any(Function))
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('opens existing absolute paths with the editor launcher', async () => {
      const child = createSpawnedProcess()
      spawnMock.mockReturnValueOnce(child)
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: workspacePath })).resolves.toEqual({ ok: true })
      expect(resolveCliCommandMock).toHaveBeenCalledWith(EXTERNAL_EDITOR_CLI_COMMAND, {
        platform: process.platform
      })
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('editor-cli', [
        normalize(workspacePath)
      ])
      expect(spawnMock).toHaveBeenCalledWith('editor-cli', [normalize(workspacePath)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      expect(child.off).toHaveBeenCalledWith('error', expect.any(Function))
      expect(child.off).toHaveBeenCalledWith('spawn', expect.any(Function))
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('uses a provided launcher command', async () => {
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: workspacePath, command: 'cursor' })).resolves.toEqual({
        ok: true
      })
      expect(resolveCliCommandMock).toHaveBeenCalledWith('cursor', { platform: process.platform })
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('editor-cli', [
        normalize(workspacePath)
      ])
    })

    it.runIf(process.platform === 'win32')(
      'forwards WSL remote arguments with spaces through the Windows launcher shim',
      async () => {
        const workspacePath = '\\\\wsl.localhost\\Ubuntu Preview\\home\\Ada Lovelace\\project'
        const codeShim = 'C:\\Tools\\CODE.CMD'
        resolveCliCommandMock.mockReturnValueOnce(codeShim)
        const handler = getHandler('shell:openInExternalEditor')

        await expect(handler({}, { path: workspacePath, command: 'code' })).resolves.toEqual({
          ok: true
        })
        expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith(codeShim, [
          '--remote',
          'wsl+Ubuntu Preview',
          '/home/Ada Lovelace/project'
        ])
      }
    )

    it('shows the Windows console for NeoVim executable launchers on Windows', async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')
      const nvimPath = 'C:\\Program Files\\Neovim\\bin\\nvim.exe'

      try {
        await expect(handler({}, { path: workspacePath, command: nvimPath })).resolves.toEqual({
          ok: true
        })
        expect(resolveCliCommandMock).not.toHaveBeenCalled()
        expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith(nvimPath, [
          normalize(workspacePath)
        ])
        expect(spawnMock).toHaveBeenCalledWith(nvimPath, [normalize(workspacePath)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
      } finally {
        if (platformDescriptor) {
          Object.defineProperty(process, 'platform', platformDescriptor)
        }
      }
    })

    it('forces Cursor launcher folders into a new window', async () => {
      resolveCliCommandMock.mockReturnValueOnce('/usr/local/bin/cursor')
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: workspacePath, command: 'cursor' })).resolves.toEqual({
        ok: true
      })
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('/usr/local/bin/cursor', [
        '--new-window',
        normalize(workspacePath)
      ])
      resolveCliCommandMock.mockReturnValueOnce('C:\\Cursor\\cursor.cmd')
      await expect(handler({}, { path: workspacePath, command: 'cursor' })).resolves.toEqual({
        ok: true
      })
      expect(getSpawnArgsForWindowsMock).toHaveBeenLastCalledWith('C:\\Cursor\\cursor.cmd', [
        '--new-window',
        normalize(workspacePath)
      ])
    })

    it('falls back to VS Code when command is blank', async () => {
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: workspacePath, command: '   ' })).resolves.toEqual({
        ok: true
      })
      expect(resolveCliCommandMock).toHaveBeenCalledWith(EXTERNAL_EDITOR_CLI_COMMAND, {
        platform: process.platform
      })
    })

    it('uses platform-safe launcher command arguments', async () => {
      getSpawnArgsForWindowsMock.mockReturnValueOnce({
        spawnCmd: 'platform-runner',
        spawnArgs: ['platform-arg']
      })
      const workspacePath = resolve('workspace')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: workspacePath })).resolves.toEqual({ ok: true })
      expect(resolveCliCommandMock).toHaveBeenCalledWith(EXTERNAL_EDITOR_CLI_COMMAND, {
        platform: process.platform
      })
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

    it('runs compound shell commands through the platform shell', async () => {
      const filePath = normalize(resolve('note.md'))
      const handler = getHandler('shell:openInExternalEditor')
      const launchSpec = resolveExternalEditorLaunchSpec('open -a "Typora"', filePath)

      await expect(handler({}, { path: filePath, command: 'open -a "Typora"' })).resolves.toEqual({
        ok: true
      })
      expect(resolveCliCommandMock).not.toHaveBeenCalled()
      expect(getSpawnArgsForWindowsMock).not.toHaveBeenCalled()
      expect(launchSpec.kind).toBe('shell')
      expect(spawnMock).toHaveBeenCalledWith(launchSpec.spawnCmd, launchSpec.spawnArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
    })

    it('rejects local and SSH launches while a remote runtime is active', async () => {
      settings.activeRuntimeEnvironmentId = 'runtime-1'
      sshTargets.set('ssh-1', createSshTarget())
      const handler = getHandler('shell:openInExternalEditor')

      await expect(handler({}, { path: resolve('workspace') })).resolves.toEqual({
        ok: false,
        reason: 'remote-runtime-unsupported'
      })
      await expect(
        handler({}, { path: '/srv/project', command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
      expect(statMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('rejects missing and runtime-owned SSH targets', async () => {
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler({}, { path: '/srv/project', command: 'code', connectionId: 'missing' })
      ).resolves.toEqual({ ok: false, reason: 'ssh-target-not-found' })

      sshTargets.set(
        'ssh-1',
        createSshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'runtime-1' } })
      )
      await expect(
        handler({}, { path: '/srv/project', command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('opens POSIX SSH paths through a persisted config alias without local validation', async () => {
      sshTargets.set('ssh-1', createSshTarget())
      resolveCliCommandMock.mockReturnValueOnce('/usr/local/bin/code')
      const handler = getHandler('shell:openInExternalEditor')
      const remotePath = '/home/Ada Lovelace/project'

      await expect(
        handler({}, { path: remotePath, command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: true })
      expect(statMock).not.toHaveBeenCalled()
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('/usr/local/bin/code', [
        '--remote',
        'ssh-remote+builder',
        remotePath
      ])
    })

    it('preserves Windows-form SSH paths and uses the manual port-22 authority', async () => {
      sshTargets.set(
        'ssh-1',
        createSshTarget({
          source: 'manual',
          configHost: 'win-builder.example.com',
          host: 'win-builder.example.com',
          username: 'Ada'
        })
      )
      resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\code.cmd')
      const handler = getHandler('shell:openInExternalEditor')
      const remotePath = 'C:\\Users\\Ada Lovelace\\project'

      await expect(
        handler({}, { path: remotePath, command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: true })
      expect(statMock).not.toHaveBeenCalled()
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('C:\\Tools\\code.cmd', [
        '--remote',
        'ssh-remote+Ada@win-builder.example.com',
        remotePath
      ])
    })

    it('opens a manual port-22 target with a host-only authority when username is blank', async () => {
      sshTargets.set(
        'ssh-1',
        createSshTarget({
          source: 'manual',
          configHost: 'builder.example.com',
          host: 'builder.example.com',
          username: ''
        })
      )
      resolveCliCommandMock.mockReturnValueOnce('/usr/local/bin/code')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler({}, { path: '/srv/project', command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: true })
      expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith('/usr/local/bin/code', [
        '--remote',
        'ssh-remote+builder.example.com',
        '/srv/project'
      ])
    })

    it('rejects relative SSH paths before resolving or spawning a launcher', async () => {
      sshTargets.set('ssh-1', createSshTarget())
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler({}, { path: 'relative/project', command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: false, reason: 'not-absolute' })
      expect(statMock).not.toHaveBeenCalled()
      expect(resolveCliCommandMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('returns alias recovery details for manual custom-port targets', async () => {
      sshTargets.set(
        'ssh-1',
        createSshTarget({
          source: 'manual',
          configHost: 'builder.example.com',
          host: 'builder.example.com',
          port: 2222
        })
      )
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler({}, { path: '/srv/project', command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({
        ok: false,
        reason: 'ssh-alias-required',
        host: 'builder.example.com',
        port: 2222
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it.each(['cursor', 'zed', 'code --reuse-window'])(
      'rejects the unsupported SSH launcher %s',
      async (command) => {
        sshTargets.set('ssh-1', createSshTarget())
        const handler = getHandler('shell:openInExternalEditor')

        await expect(
          handler({}, { path: '/srv/project', command, connectionId: 'ssh-1' })
        ).resolves.toEqual({ ok: false, reason: 'remote-editor-unsupported' })
        expect(spawnMock).not.toHaveBeenCalled()
      }
    )

    it('maps unsafe Windows batch arguments to a closed launch failure', async () => {
      sshTargets.set('ssh-1', createSshTarget())
      resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\code.cmd')
      getSpawnArgsForWindowsMock.mockImplementationOnce(() => {
        throw new Error('unsafe batch arguments')
      })
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler({}, { path: '/srv/project&whoami', command: 'code', connectionId: 'ssh-1' })
      ).resolves.toEqual({ ok: false, reason: 'launch-failed' })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  describe('legacy file open handlers', () => {
    it('does not open relative file paths', async () => {
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, 'relative/file.md')).resolves.toBe(false)
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('does not open missing file paths', async () => {
      statMock.mockRejectedValueOnce(new Error('missing'))
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, resolve('missing.md'))).resolves.toBe(false)
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('returns true when the host launcher accepts file paths', async () => {
      const filePath = resolve('note.md')
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, filePath)).resolves.toBe(true)
      expect(openPathMock).toHaveBeenCalledWith(normalize(filePath))
    })

    it('returns false for host launcher failures for file paths', async () => {
      openPathMock.mockRejectedValueOnce(new Error('launcher unavailable'))
      const filePath = resolve('note.md')
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, filePath)).resolves.toBe(false)
      expect(openPathMock).toHaveBeenCalledWith(normalize(filePath))
    })

    it('returns false when the host launcher reports file path errors', async () => {
      openPathMock.mockResolvedValueOnce('no default app')
      const filePath = resolve('note.md')
      const handler = getHandler('shell:openFilePath')

      await expect(handler({}, filePath)).resolves.toBe(false)
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
