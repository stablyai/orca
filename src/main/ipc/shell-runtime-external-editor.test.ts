import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalize, resolve } from 'node:path'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'

const { getSpawnArgsForWindowsMock, handleMock, resolveCliCommandMock, spawnMock, statMock } =
  vi.hoisted(() => ({
    getSpawnArgsForWindowsMock: vi.fn(),
    handleMock: vi.fn(),
    resolveCliCommandMock: vi.fn(),
    spawnMock: vi.fn(),
    statMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  shell: {
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(),
    openPath: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('node:fs/promises', () => ({
  constants: { COPYFILE_EXCL: 1 },
  copyFile: vi.fn(),
  stat: statMock
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('../codex-cli/command', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

vi.mock('../win32-utils', () => ({
  getCmdExePath: () => 'C:\\Windows\\System32\\cmd.exe',
  getSpawnArgsForWindows: getSpawnArgsForWindowsMock
}))

import { registerShellHandlers } from './shell'

function spawnedProcess(): {
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

function sshTarget(overrides: Partial<SshTarget> = {}): SshTarget {
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

function runtimeEnvironment(
  overrides: Partial<KnownRuntimeEnvironment> = {}
): KnownRuntimeEnvironment {
  return {
    id: 'runtime-1',
    name: 'Runtime builder',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: 'server-runtime-1',
    endpoints: [
      {
        id: 'ws-runtime-1',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'wss://builder.example.com:6768',
        deviceToken: 'token',
        publicKeyB64: 'public-key'
      }
    ],
    preferredEndpointId: 'ws-runtime-1',
    ...overrides
  }
}

describe('runtime external editor shell routing', () => {
  const settings = { activeRuntimeEnvironmentId: null as string | null }
  const sshTargets = new Map<string, SshTarget>()
  const runtimeEnvironments = new Map<string, KnownRuntimeEnvironment>()
  const store = {
    getSettings: () => settings,
    getSshTarget: (id: string) => sshTargets.get(id),
    getSshTargets: () => [...sshTargets.values()]
  }

  beforeEach(() => {
    handleMock.mockReset()
    getSpawnArgsForWindowsMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
    spawnMock.mockReset()
    statMock.mockReset()
    settings.activeRuntimeEnvironmentId = null
    sshTargets.clear()
    runtimeEnvironments.clear()
    getSpawnArgsForWindowsMock.mockImplementation((command: string, args: string[]) => ({
      spawnCmd: command,
      spawnArgs: args
    }))
    spawnMock.mockReturnValue(spawnedProcess())
    statMock.mockResolvedValue({ isDirectory: () => true })
  })

  function handler(): (event: unknown, request: unknown) => Promise<unknown> {
    registerShellHandlers(store as never, {
      resolveRuntimeEnvironment: (environmentId) => runtimeEnvironments.get(environmentId)
    })
    const call = handleMock.mock.calls.find((entry: unknown[]) => {
      return entry[0] === 'shell:openInExternalEditor'
    })
    if (!call) {
      throw new Error('shell:openInExternalEditor handler not registered')
    }
    return call[1] as (event: unknown, request: unknown) => Promise<unknown>
  }

  it('opens a Runtime path in VS Code through the matching local SSH target', async () => {
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())
    sshTargets.set('ssh-1', sshTarget())
    resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\code.cmd')
    const remotePath = '/srv/Ada Project'

    await expect(
      handler()({}, { path: remotePath, command: 'code', executionHostId: 'runtime:runtime-1' })
    ).resolves.toEqual({ ok: true })
    expect(statMock).not.toHaveBeenCalled()
    expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith(
      'C:\\Tools\\code.cmd',
      ['--remote', 'ssh-remote+builder', remotePath],
      { detachedGui: false }
    )
  })

  it('opens a Runtime path in Cursor through the matching local SSH target', async () => {
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())
    sshTargets.set('ssh-1', sshTarget())
    resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\cursor.cmd')
    const remotePath = '/srv/Ada Project'

    await expect(
      handler()({}, { path: remotePath, command: 'cursor', executionHostId: 'runtime:runtime-1' })
    ).resolves.toEqual({ ok: true })
    expect(statMock).not.toHaveBeenCalled()
    expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith(
      'C:\\Tools\\cursor.cmd',
      ['--remote', 'ssh-remote+builder', remotePath],
      { detachedGui: false }
    )
  })

  it('opens a Runtime path in Zed with an encoded SSH URI', async () => {
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())
    sshTargets.set('ssh-1', sshTarget())
    resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\zed.exe')

    await expect(
      handler()(
        {},
        {
          path: '/srv/Ada Project/\u6587\u6863',
          command: 'zed',
          executionHostId: 'runtime:runtime-1'
        }
      )
    ).resolves.toEqual({ ok: true })
    expect(statMock).not.toHaveBeenCalled()
    expect(getSpawnArgsForWindowsMock).toHaveBeenCalledWith(
      'C:\\Tools\\zed.exe',
      ['--new', 'ssh://builder/srv/Ada%20Project/%E6%96%87%E6%A1%A3'],
      { detachedGui: false }
    )
  })

  it('fails closed when no local SSH target matches the Runtime endpoint', async () => {
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())

    await expect(
      handler()({}, { path: '/srv/project', command: 'code', executionHostId: 'runtime:runtime-1' })
    ).resolves.toEqual({ ok: false, reason: 'runtime-ssh-target-required' })
    expect(statMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects nested SSH context on a Runtime-owned request', async () => {
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())
    sshTargets.set('ssh-1', sshTarget())

    await expect(
      handler()(
        {},
        {
          path: '/srv/project',
          command: 'code',
          connectionId: 'ssh-1',
          executionHostId: 'runtime:runtime-1'
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
    expect(statMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects relative Runtime paths without local filesystem access', async () => {
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())
    sshTargets.set('ssh-1', sshTarget())

    await expect(
      handler()(
        {},
        { path: 'relative/project', command: 'code', executionHostId: 'runtime:runtime-1' }
      )
    ).resolves.toEqual({ ok: false, reason: 'not-absolute' })
    expect(statMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('honors explicit Runtime ownership while another Runtime is active', async () => {
    settings.activeRuntimeEnvironmentId = 'runtime-2'
    runtimeEnvironments.set('runtime-1', runtimeEnvironment())
    sshTargets.set('ssh-1', sshTarget())
    resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\code.cmd')

    await expect(
      handler()({}, { path: '/srv/project', command: 'code', executionHostId: 'runtime:runtime-1' })
    ).resolves.toEqual({ ok: true })
    expect(statMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
  })

  it('honors explicit SSH ownership while a Runtime is active', async () => {
    settings.activeRuntimeEnvironmentId = 'runtime-1'
    sshTargets.set('ssh-1', sshTarget())
    resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\code.cmd')

    await expect(
      handler()(
        {},
        {
          path: '/home/project',
          command: 'code',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      )
    ).resolves.toEqual({ ok: true })
    expect(statMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
  })

  it('honors explicit local ownership while another Runtime is active', async () => {
    settings.activeRuntimeEnvironmentId = 'runtime-1'
    const workspacePath = resolve('workspace')

    await expect(
      handler()({}, { path: workspacePath, command: 'code', executionHostId: 'local' })
    ).resolves.toEqual({ ok: true })
    expect(statMock).toHaveBeenCalledWith(normalize(workspacePath))
    expect(spawnMock).toHaveBeenCalled()
  })
})
