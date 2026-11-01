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

import { registerShellHandlers } from './shell'
import type { SshTarget } from '../../shared/ssh-types'

const HIDDEN_EDITOR_LAUNCH_OPTIONS = expect.objectContaining({
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  shell: false
})

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

  describe('shell:openInFileManager', () => {
    it('rejects relative paths', async () => {
      const handler = getHandler('shell:openInFileManager')

      await expect(handler({}, 'relative/workspace', 'local')).resolves.toEqual({
        ok: false,
        reason: 'not-absolute'
      })
      expect(statMock).not.toHaveBeenCalled()
      expect(showItemInFolderMock).not.toHaveBeenCalled()
    })
  })

  describe('shell:openInExternalEditor', () => {
    it.runIf(process.platform === 'win32')(
      'forwards WSL remote arguments with spaces through the Windows launcher shim',
      async () => {
        const workspacePath = '\\\\wsl.localhost\\Ubuntu Preview\\home\\Ada Lovelace\\project'
        const codeShim = 'C:\\Tools\\CODE.CMD'
        resolveCliCommandMock.mockReturnValueOnce(codeShim)
        const handler = getHandler('shell:openInExternalEditor')

        await expect(
          handler({}, { path: workspacePath, command: 'code', ownerHostId: 'local' })
        ).resolves.toEqual({
          ok: true
        })
        expect(getSpawnArgsForWindowsMock).not.toHaveBeenCalled()
        expect(spawnMock).toHaveBeenCalledWith(
          expect.any(String),
          [expect.stringContaining('"wsl+Ubuntu Preview" "/home/Ada Lovelace/project"')],
          expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true })
        )
      }
    )

    it('rejects missing and runtime-owned SSH targets', async () => {
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler(
          {},
          {
            path: '/srv/project',
            command: 'code',
            connectionId: 'missing',
            ownerHostId: 'ssh:missing'
          }
        )
      ).resolves.toEqual({ ok: false, reason: 'ssh-target-not-found' })

      sshTargets.set(
        'ssh-1',
        createSshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'runtime-1' } })
      )
      await expect(
        handler(
          {},
          { path: '/srv/project', command: 'code', connectionId: 'ssh-1', ownerHostId: 'ssh:ssh-1' }
        )
      ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('opens POSIX SSH paths through a persisted config alias without local validation', async () => {
      sshTargets.set('ssh-1', createSshTarget())
      resolveCliCommandMock.mockReturnValueOnce('/usr/local/bin/code')
      const handler = getHandler('shell:openInExternalEditor')
      const remotePath = '/home/Ada Lovelace/project'

      await expect(
        handler(
          {},
          { path: remotePath, command: 'code', connectionId: 'ssh-1', ownerHostId: 'ssh:ssh-1' }
        )
      ).resolves.toEqual({ ok: true })
      expect(statMock).not.toHaveBeenCalled()
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/code',
        ['--remote', 'ssh-remote+builder', remotePath],
        HIDDEN_EDITOR_LAUNCH_OPTIONS
      )
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
        handler(
          {},
          { path: remotePath, command: 'code', connectionId: 'ssh-1', ownerHostId: 'ssh:ssh-1' }
        )
      ).resolves.toEqual({ ok: true })
      expect(statMock).not.toHaveBeenCalled()
      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Tools\\code.cmd',
        ['--remote', 'ssh-remote+Ada@win-builder.example.com', remotePath],
        HIDDEN_EDITOR_LAUNCH_OPTIONS
      )
    })

    it('rejects relative SSH paths before resolving or spawning a launcher', async () => {
      sshTargets.set('ssh-1', createSshTarget())
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler(
          {},
          {
            path: 'relative/project',
            command: 'code',
            connectionId: 'ssh-1',
            ownerHostId: 'ssh:ssh-1'
          }
        )
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
      resolveCliCommandMock.mockReturnValueOnce('/usr/local/bin/code')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler(
          {},
          { path: '/srv/project', command: 'code', connectionId: 'ssh-1', ownerHostId: 'ssh:ssh-1' }
        )
      ).resolves.toEqual({
        ok: false,
        reason: 'ssh-alias-required',
        host: 'builder.example.com',
        port: 2222
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('opens a manual custom-port target in Zed without an SSH config alias', async () => {
      sshTargets.set(
        'ssh-1',
        createSshTarget({
          source: 'manual',
          configHost: 'builder.example.com',
          host: 'builder.example.com',
          port: 2222
        })
      )
      resolveCliCommandMock.mockReturnValueOnce('/usr/local/bin/zed')
      const handler = getHandler('shell:openInExternalEditor')

      await expect(
        handler(
          {},
          { path: '/srv/project', command: 'zed', connectionId: 'ssh-1', ownerHostId: 'ssh:ssh-1' }
        )
      ).resolves.toEqual({ ok: true })
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/zed',
        ['ssh://ada@builder.example.com:2222/srv/project'],
        HIDDEN_EDITOR_LAUNCH_OPTIONS
      )
    })

    it.each(['subl', 'code --reuse-window'])(
      'rejects the unsupported SSH launcher %s',
      async (command) => {
        sshTargets.set('ssh-1', createSshTarget())
        const handler = getHandler('shell:openInExternalEditor')

        await expect(
          handler(
            {},
            { path: '/srv/project', command, connectionId: 'ssh-1', ownerHostId: 'ssh:ssh-1' }
          )
        ).resolves.toEqual({ ok: false, reason: 'remote-editor-unsupported' })
        expect(spawnMock).not.toHaveBeenCalled()
      }
    )

    it('quotes cmd metacharacters in a Windows code.cmd launch so cmd never runs them', async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      sshTargets.set('ssh-1', createSshTarget())
      resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\code.cmd')
      const handler = getHandler('shell:openInExternalEditor')

      try {
        await expect(
          handler(
            {},
            {
              path: '/srv/project&whoami',
              command: 'code',
              connectionId: 'ssh-1',
              ownerHostId: 'ssh:ssh-1'
            }
          )
        ).resolves.toEqual({ ok: true })
        expect(spawnMock).toHaveBeenCalledWith(
          expect.any(String),
          [
            '/d /v:off /s /c ""C:\\Tools\\code.cmd" "--remote" "ssh-remote+builder" "/srv/project&whoami""'
          ],
          expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true })
        )
      } finally {
        if (platformDescriptor) {
          Object.defineProperty(process, 'platform', platformDescriptor)
        }
      }
    })
  })

  describe('legacy file open handlers', () => {
    it('does not open non-file URIs', async () => {
      const handler = getHandler('shell:openFileUri')

      await expect(handler({}, 'https://example.com/file.md', 'local')).resolves.toBeUndefined()
      expect(openPathMock).not.toHaveBeenCalled()
    })

    it('does not open remote file URIs', async () => {
      const handler = getHandler('shell:openFileUri')

      await expect(handler({}, 'file://server/share/file.md', 'local')).resolves.toBeUndefined()
      expect(openPathMock).not.toHaveBeenCalled()
    })
  })

  describe('owner routing', () => {
    it('reveals and opens a local-owned path while a remote server is focused', async () => {
      settings.activeRuntimeEnvironmentId = 'runtime-1'
      const workspacePath = resolve('workspace')

      await expect(
        getHandler('shell:openInFileManager')({}, workspacePath, 'local')
      ).resolves.toEqual({ ok: true })
      expect(showItemInFolderMock).toHaveBeenCalledWith(normalize(workspacePath))
      await expect(
        getHandler('shell:openInExternalEditor')({}, { path: workspacePath, ownerHostId: 'local' })
      ).resolves.toEqual({ ok: true })
      await expect(getHandler('shell:openFilePath')({}, workspacePath, 'local')).resolves.toBe(true)
    })

    it('refuses SSH, server and missing owners without touching the local filesystem', async () => {
      const path = resolve('workspace')
      const refused = { ok: false, reason: 'remote-runtime-unsupported' }
      for (const owner of ['ssh:ssh-1', 'runtime:env-1', undefined, 'bogus']) {
        const call = (channel: string, arg: unknown = path) => getHandler(channel)({}, arg, owner)
        await expect(call('shell:openInFileManager')).resolves.toEqual(refused)
        await expect(call('shell:openPath')).resolves.toBe(undefined)
        await expect(call('shell:openFilePath')).resolves.toBe(false)
        await call('shell:openFileUri', pathToFileURL(path).toString())
        await expect(
          getHandler('shell:openInExternalEditor')({}, { path, ownerHostId: owner })
        ).resolves.toEqual(refused)
      }
      expect(statMock).not.toHaveBeenCalled()
      expect(showItemInFolderMock).not.toHaveBeenCalled()
      expect(openPathMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('opens an SSH path remotely only when the owner is that same SSH target', async () => {
      settings.activeRuntimeEnvironmentId = 'runtime-1'
      sshTargets.set('ssh-1', createSshTarget())
      resolveCliCommandMock.mockReturnValue('/usr/local/bin/code')
      const handler = getHandler('shell:openInExternalEditor')
      const request = { path: '/srv/project', command: 'code', connectionId: 'ssh-1' }

      const refused = { ok: false, reason: 'remote-runtime-unsupported' }
      await expect(handler({}, { ...request, ownerHostId: 'ssh:ssh-2' })).resolves.toEqual(refused)
      await expect(handler({}, { ...request, ownerHostId: 'local' })).resolves.toEqual(refused)
      expect(spawnMock).not.toHaveBeenCalled()
      await expect(handler({}, { ...request, ownerHostId: 'ssh:ssh-1' })).resolves.toEqual({
        ok: true
      })
      expect(spawnMock).toHaveBeenCalledTimes(1)
    })
  })
})
