import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSpawnArgsForWindowsMock,
  handleMock,
  inspectLinkedFileMock,
  openPathMock,
  resolveCliCommandMock,
  showItemInFolderMock,
  showOpenDialogMock,
  spawnMock,
  statMock
} = vi.hoisted(() => ({
  getSpawnArgsForWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  inspectLinkedFileMock: vi.fn(),
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
  stat: statMock
}))

vi.mock('./linked-file-inspection', () => ({
  inspectLinkedFile: inspectLinkedFileMock
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
import type { OpenInApplication } from '../../shared/ui-chrome-types'
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
  const settings: {
    activeRuntimeEnvironmentId: string | null
    openInApplications: OpenInApplication[]
  } = { activeRuntimeEnvironmentId: null, openInApplications: [] }
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
    settings.openInApplications = []
    sshTargets.clear()
    openPathMock.mockResolvedValue('')
    resolveCliCommandMock.mockReturnValue('editor-cli')
    getSpawnArgsForWindowsMock.mockImplementation((command: string, args: string[]) => ({
      spawnCmd: command,
      spawnArgs: args
    }))
    spawnMock.mockReturnValue(createSpawnedProcess())
    statMock.mockResolvedValue({ isDirectory: () => true })
    inspectLinkedFileMock.mockReset()
    inspectLinkedFileMock.mockResolvedValue('open')
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
    it.skipIf(process.platform === 'win32')(
      'launches only editors main resolves from settings or built-ins',
      async () => {
        settings.openInApplications = [{ id: 'mine', label: 'Mine', command: 'my-editor --wait' }]
        const handler = getHandler('shell:openInExternalEditor')
        const local = { path: '/tmp/project', ownerHostId: 'local' }

        for (const request of [
          { openInApplicationId: 'unknown' },
          { builtInEditorId: 'unknown' },
          { command: 'touch /tmp/pwned' }
        ]) {
          await expect(handler({}, { ...local, ...request })).resolves.toEqual({
            ok: false,
            reason: 'launch-failed'
          })
        }
        expect(spawnMock).not.toHaveBeenCalled()

        await expect(handler({}, { ...local, openInApplicationId: 'mine' })).resolves.toEqual({
          ok: true
        })
        expect(spawnMock).toHaveBeenLastCalledWith(
          '/bin/sh',
          ['-c', 'my-editor --wait /tmp/project'],
          expect.anything()
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
        createSshTarget({
          owner: { type: 'on-demand-runtime', runtimeId: 'runtime-1' }
        })
      )
      await expect(
        handler(
          {},
          {
            path: '/srv/project',
            command: 'code',
            connectionId: 'ssh-1',
            ownerHostId: 'ssh:ssh-1'
          }
        )
      ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  describe('linked file opens', () => {
    const scriptPath = process.platform === 'win32' ? 'C:\\x\\run.sh' : '/x/run.sh'
    const scriptUri = process.platform === 'win32' ? 'file:///C:/x/run.sh' : 'file:///x/run.sh'

    it.each([
      ['open', 'opened', true],
      ['reveal', 'revealed', true],
      ['view-as-text', 'open-in-editor', true]
    ] as const)('maps %s to %s for Markdown links', async (action, uriResult, pathResult) => {
      inspectLinkedFileMock.mockResolvedValue(action)

      await expect(getHandler('shell:openFileUri')({}, scriptUri, 'local')).resolves.toBe(uriResult)
      await expect(getHandler('shell:openFilePath')({}, scriptPath, 'local')).resolves.toBe(
        pathResult
      )
      // Only plain documents reach the OS default app; scripts never do.
      expect(openPathMock).toHaveBeenCalledTimes(action === 'open' ? 2 : 0)
      // A path open has no editor to fall back on, so scripts are revealed there.
      expect(showItemInFolderMock).toHaveBeenCalledTimes(
        action === 'reveal' ? 2 : action === 'view-as-text' ? 1 : 0
      )
    })

    it('refuses non-local owners and remote file URIs before inspecting', async () => {
      const handler = getHandler('shell:openFileUri')

      await expect(handler({}, scriptUri, 'ssh:ssh-1')).resolves.toBe('failed')
      await expect(handler({}, 'file://server/share/run.sh', 'local')).resolves.toBe('failed')
      await expect(handler({}, 'https://example.com/run.sh', 'local')).resolves.toBe('failed')
      expect(inspectLinkedFileMock).not.toHaveBeenCalled()
      expect(openPathMock).not.toHaveBeenCalled()
    })
  })
})
