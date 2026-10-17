import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSpawnArgsForWindowsMock, handleMock, resolveCliCommandMock, spawnMock, statMock } =
  vi.hoisted(() => ({
    getSpawnArgsForWindowsMock: vi.fn(),
    handleMock:
      vi.fn<
        (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => void
      >(),
    resolveCliCommandMock: vi.fn(),
    spawnMock: vi.fn(),
    statMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(), openPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('node:fs/promises', () => ({
  constants: { COPYFILE_EXCL: 1 },
  copyFile: vi.fn(),
  stat: statMock
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('../codex-cli/command', () => ({ resolveCliCommand: resolveCliCommandMock }))

vi.mock('../win32-utils', () => ({
  getCmdExePath: () => 'C:\\Windows\\System32\\cmd.exe',
  getSpawnArgsForWindows: getSpawnArgsForWindowsMock
}))

import { registerShellHandlers } from './shell'
import type { SshTarget } from '../../shared/ssh-types'

function createSpawnedProcess(): {
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
} {
  const child = {
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'spawn') {
        queueMicrotask(callback)
      }
      return child
    }),
    off: vi.fn(() => child),
    unref: vi.fn()
  }
  return child
}

const SSH_TARGET: SshTarget = {
  id: 'ssh-1',
  label: 'Builder',
  host: 'builder.example.com',
  port: 22,
  username: 'ada',
  source: 'ssh-config',
  configHost: 'builder'
}

describe('opening a managed server path in an external editor', () => {
  const sshTargets = new Map<string, SshTarget>()
  const runtimeSshTargetIds = new Map<string, string>()

  beforeEach(() => {
    handleMock.mockReset()
    getSpawnArgsForWindowsMock.mockReset()
    resolveCliCommandMock.mockReset()
    spawnMock.mockReset()
    statMock.mockReset()
    sshTargets.clear()
    runtimeSshTargetIds.clear()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/code')
    getSpawnArgsForWindowsMock.mockImplementation((command: string, args: string[]) => ({
      spawnCmd: command,
      spawnArgs: args
    }))
    spawnMock.mockReturnValue(createSpawnedProcess())
  })

  function getHandler(): (event: unknown, ...args: unknown[]) => Promise<unknown> {
    registerShellHandlers(
      { getSshTarget: (id: string) => sshTargets.get(id) },
      (environmentId) => runtimeSshTargetIds.get(environmentId) ?? null
    )
    const call = handleMock.mock.calls.find(([channel]) => channel === 'shell:openInExternalEditor')
    if (!call) {
      throw new Error('shell:openInExternalEditor handler not registered')
    }
    return call[1]
  }

  it('opens the path through the SSH host the server is reached over', async () => {
    sshTargets.set('ssh-1', SSH_TARGET)
    runtimeSshTargetIds.set('env-1', 'ssh-1')

    await expect(
      getHandler()({}, { path: '/home/coder/orca', command: 'code', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: true })
    expect(statMock).not.toHaveBeenCalled()
    expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith(
      '/usr/local/bin/code',
      ['--remote', 'ssh-remote+builder', '/home/coder/orca'],
      { detachedGui: false }
    )
  })

  it('refuses a server whose SSH host is gone, or a relative path', async () => {
    runtimeSshTargetIds.set('env-1', 'ssh-1')
    const handler = getHandler()

    await expect(
      handler({}, { path: '/srv/project', command: 'code', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: false, reason: 'ssh-target-not-found' })

    sshTargets.set('ssh-1', SSH_TARGET)
    await expect(
      handler({}, { path: 'project', command: 'code', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: false, reason: 'not-absolute' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('still refuses a runtime owner that has no SSH link', async () => {
    await expect(
      getHandler()({}, { path: '/srv/project', command: 'code', ownerHostId: 'runtime:env-2' })
    ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
