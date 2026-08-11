import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: undefined,
  app: {
    isPackaged: true,
    getPath: () => '/tmp/orca-pty-owner-test',
    getVersion: () => '0.0.0-test'
  },
  powerMonitor: { on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import {
  getLocalPtyProvider,
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'

type SpawnOwner = {
  executionHostId: ExecutionHostId
  connectionId: string | null
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makePtyProvider(spawn: ReturnType<typeof vi.fn>) {
  return {
    spawn,
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => [])
  }
}

function registerHandlers(runtime?: object, store?: object) {
  const handlers = new Map<string, (event: unknown, args: Record<string, unknown>) => unknown>()
  handleMock.mockImplementation(
    (channel: string, handler: (event: unknown, args: Record<string, unknown>) => unknown) => {
      handlers.set(channel, handler)
    }
  )
  removeHandlerMock.mockImplementation((channel: string) => handlers.delete(channel))
  onMock.mockImplementation((channel: string, listener: (event: unknown) => void) => {
    if (channel === 'pty:rendererDispatcherReady') {
      listener({ sender: mainWindow.webContents })
    }
  })
  registerPtyHandlers(
    mainWindow as never,
    runtime as never,
    undefined,
    undefined,
    undefined,
    store as never
  )
  return handlers
}

describe('folder workspace PTY spawn owner lease', () => {
  const connectionId = 'ssh-deleted-owner'
  const originalLocalProvider = getLocalPtyProvider()

  afterEach(() => {
    unregisterSshPtyProvider(connectionId)
    unregisterSshFilesystemProvider(connectionId)
    setLocalPtyProvider(originalLocalProvider)
    vi.clearAllMocks()
  })

  it('rejects a queued renderer SSH spawn when only its same-key local sibling survives', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'resurrected-ssh-pty' }))
    registerSshPtyProvider(connectionId, makePtyProvider(providerSpawn) as never)
    registerSshFilesystemProvider(connectionId, {
      stat: vi.fn(async () => ({ size: 0, type: 'directory', mtime: 1 }))
    } as never)
    const leaseGate = deferred()
    let sshOwnerExists = true
    const localSiblingExists = true
    const acquireWorktreeTerminalSpawn = vi.fn(
      async (_worktreeId: string | undefined, expectedOwner?: SpawnOwner) => {
        await leaseGate.promise
        const expectedOwnerExists = expectedOwner
          ? expectedOwner.connectionId === connectionId && sshOwnerExists
          : sshOwnerExists || localSiblingExists
        if (!expectedOwnerExists) {
          throw new Error('folder_workspace_not_found')
        }
        return () => {}
      }
    )
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_ssh_owner'),
      acquireWorktreeTerminalSpawn
    }
    const store = {
      getRepos: () => [],
      getProjectGroups: () => [
        { id: 'group-1', connectionId: null },
        { id: 'group-1', connectionId }
      ],
      getFolderWorkspaces: () => [
        ...(sshOwnerExists
          ? [
              {
                id: 'same-id-folder',
                projectGroupId: 'group-1',
                folderPath: '/workspace/same-id-folder',
                connectionId
              }
            ]
          : []),
        {
          id: 'same-id-folder',
          projectGroupId: 'group-1',
          folderPath: '/local/same-id-folder',
          connectionId: null
        }
      ]
    }
    const handlers = registerHandlers(runtime, store)
    const worktreeId = folderWorkspaceKey('same-id-folder')

    const spawn = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/workspace/same-id-folder',
      connectionId,
      worktreeId
    }) as Promise<unknown>
    void spawn.catch(() => {})
    await vi.waitFor(() => expect(acquireWorktreeTerminalSpawn).toHaveBeenCalled())

    sshOwnerExists = false
    leaseGate.resolve()

    await expect(spawn).rejects.toThrow('folder_workspace_not_found')
    expect(acquireWorktreeTerminalSpawn).toHaveBeenCalledWith(worktreeId, {
      executionHostId: toSshExecutionHostId(connectionId),
      connectionId
    })
    expect(providerSpawn).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'local-first catalogs with omitted local connection', reversed: false },
    { label: 'SSH-first catalogs with null local connection', reversed: true }
  ])('uses the physical folder owner for preflight and startup cwd: $label', async (testCase) => {
    const localRoot = await mkdtemp(join(tmpdir(), 'orca-pty-local-owner-'))
    const remoteRoot = '/remote/physical-owner'
    const sshStat = vi.fn(async () => ({ size: 0, type: 'directory', mtime: 1 }))
    const sshSpawn = vi.fn(async () => ({ id: 'ssh-owner-pty' }))
    const localSpawn = vi.fn(async () => ({ id: 'local-owner-pty' }))
    const ordered = <T>(local: T, ssh: T): T[] => (testCase.reversed ? [ssh, local] : [local, ssh])

    try {
      registerSshPtyProvider(connectionId, makePtyProvider(sshSpawn) as never)
      registerSshFilesystemProvider(connectionId, { stat: sshStat } as never)
      setLocalPtyProvider(makePtyProvider(localSpawn) as never)
      const store = {
        getRepos: () => [],
        upsertSshRemotePtyLease: vi.fn(),
        getProjectGroups: () =>
          ordered({ id: 'group-1', connectionId: null }, { id: 'group-1', connectionId }),
        getFolderWorkspaces: () =>
          ordered(
            {
              id: 'same-id-folder',
              projectGroupId: 'group-1',
              folderPath: localRoot,
              connectionId: null
            },
            {
              id: 'same-id-folder',
              projectGroupId: 'group-1',
              folderPath: remoteRoot,
              connectionId
            }
          )
      }
      const handlers = registerHandlers(undefined, store)
      const worktreeId = folderWorkspaceKey('same-id-folder')

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: 'nested',
        connectionId,
        worktreeId
      })

      expect(sshStat).toHaveBeenCalledTimes(1)
      expect(sshStat).toHaveBeenCalledWith(remoteRoot)
      expect(sshSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: `${remoteRoot}/nested` })
      )

      const missingLocalCwd = join(localRoot, 'deleted')
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: missingLocalCwd,
        cwdFallback: 'worktree',
        ...(testCase.reversed ? { connectionId: null } : {}),
        worktreeId
      })

      expect(localSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: localRoot }))
      expect(result).toMatchObject({ startupCwdFallback: { kind: 'worktree', cwd: localRoot } })
      expect(sshStat).toHaveBeenCalledTimes(1)
      expect(sshSpawn).toHaveBeenCalledTimes(1)
    } finally {
      await rm(localRoot, { recursive: true, force: true })
    }
  })
})

const mainWindow = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  webContents: {
    id: 1,
    isDestroyed: () => false,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn()
  }
}
