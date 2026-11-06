import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

vi.mock('../../shared/windows-batch-spawn', () => ({
  getCmdExePath: () => 'C:\\Windows\\System32\\cmd.exe',
  getSpawnArgsForWindows: getSpawnArgsForWindowsMock
}))

import { registerShellHandlers } from './shell'
import type { SshTarget } from '../../shared/ssh-types'
expect.objectContaining({
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

  describe('shell:openInExternalEditor', () => {
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
  })
})
