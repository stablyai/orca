import { describe, expect, it, vi } from 'vitest'
import { spawnMock, registerPtyMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('retires a dead owner from the exact SSH host session before fresh recovery', async () => {
    const connectionId = 'ssh-dead-stable-pane'
    const hostId = `ssh:${connectionId}`
    const tabId = 'tab-dead-ssh-owner'
    const leafId = '34343434-3434-4434-8434-343434343434'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-ssh::/remote/dead-stable-pane'
    const deadPtyId = `ssh:${connectionId}@@dead-relay-pty`
    const freshPtyId = `ssh:${connectionId}@@fresh-relay-pty`
    const remoteSpawn = vi.fn(async (options: { attachOnly?: boolean; command?: string }) => {
      if (options.attachOnly) {
        throw new Error('PTY "dead-relay-pty" not found')
      }
      return { id: freshPtyId, incarnationId: 'inc-fresh-ssh-owner' }
    })
    registerSshPtyProvider(connectionId, {
      spawn: remoteSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    let session = {
      tabsByWorktree: {
        [worktreeId]: [{ id: tabId, worktreeId, ptyId: deadPtyId }]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: deadPtyId }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-dead-ssh-owner' }
    }
    const store = {
      getWorkspaceSession: vi.fn((requestedHostId?: string) => {
        expect(requestedHostId).toBe(hostId)
        return session
      }),
      setWorkspaceSession: vi.fn((next, requestedHostId?: string) => {
        expect(requestedHostId).toBe(hostId)
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      upsertSshRemotePtyLease: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-fresh-ssh-owner'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    try {
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const mounted = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/remote/dead-stable-pane',
        command: 'codex resume exact-dead-ssh-provider-session',
        connectionId,
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })

      expect(mounted).toMatchObject({ id: freshPtyId, incarnationId: 'inc-fresh-ssh-owner' })
      expect(remoteSpawn).toHaveBeenCalledTimes(2)
      expect(remoteSpawn.mock.calls[0]?.[0]).toMatchObject({
        attachOnly: true,
        sessionId: deadPtyId,
        command: undefined
      })
      expect(remoteSpawn.mock.calls[1]?.[0]).toMatchObject({
        command: 'codex resume exact-dead-ssh-provider-session'
      })
      expect(store.setWorkspaceSession).toHaveBeenCalledWith(expect.anything(), hostId)
      expect(store.persistPtyBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId,
          tabId,
          leafId,
          ptyId: freshPtyId
        }),
        hostId
      )
    } finally {
      unregisterSshPtyProvider(connectionId)
    }
  })
  it('fails closed when runtime and persisted stable-pane owners conflict', async () => {
    const tabId = 'tab-conflicting-owner'
    const leafId = '99999999-9999-4999-8999-999999999999'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-1::/tmp/conflicting-owner'
    const providerSpawn = vi.fn()
    setLocalPtyProvider({
      spawn: providerSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => ({
        handle: 'term-runtime-owner',
        tabId,
        leafId,
        ptyId: 'pty-runtime-owner',
        worktreeId
      })),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-provisional')
    }
    const store = {
      getWorkspaceSession: vi.fn(() => ({
        tabsByWorktree: {
          [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-persisted-owner' }]
        },
        terminalLayoutsByTabId: {
          [tabId]: { ptyIdsByLeafId: { [leafId]: 'pty-persisted-owner' } }
        }
      }))
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp/conflicting-owner',
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })
    ).rejects.toThrow('terminal_pane_owner_conflict')
    expect(providerSpawn).not.toHaveBeenCalled()
  })
  it('does not coalesce identical pane coordinates across worktrees', async () => {
    const providerSpawn = vi.fn(async () => ({ id: `pty-${providerSpawn.mock.calls.length}` }))
    setLocalPtyProvider({
      spawn: providerSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(mainWindow as never)
    const leafId = '77777777-7777-4777-8777-777777777777'
    const paneKey = makePaneKey('tab-host-scope', leafId)
    const spawn = (worktreeId: string) =>
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId,
        tabId: 'tab-host-scope',
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-host-scope',
          ORCA_WORKTREE_ID: worktreeId
        }
      })

    await Promise.all([spawn('repo-1::/tmp/a'), spawn('repo-1::/tmp/b')])

    expect(providerSpawn).toHaveBeenCalledTimes(2)
  })
  it('settles the pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Why: reservation-leak regression — a post-spawn throw after provider.spawn resolves must reject/clear the reservation, else later spawns for the same pane key hang forever.
    registerPtyHandlers(mainWindow as never)
    const leafId = '44444444-4444-4444-8444-444444444444'
    const spawnArgs = { cols: 80, rows: 24, tabId: 'tab-reservation', leafId }

    registerPtyMock.mockImplementationOnce(() => {
      throw new Error('boom: post-spawn registration failed')
    })

    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow('boom')

    // A second spawn for the same pane must run a fresh spawn rather than await the leaked (never-settled) reservation promise.
    let hangTimer: ReturnType<typeof setTimeout> | undefined
    const second = handlers.get('pty:spawn')!(null, spawnArgs) as Promise<{ id: string }>
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('second spawn hung: pane reservation leaked')),
          1000
        )
      })
    ]).finally(() => clearTimeout(hangTimer))

    expect(result.id).toEqual(expect.any(String))
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
  it('settles the runtime-owned pane reservation when a post-spawn step throws so later spawns do not hang', async () => {
    // Why: like the renderer-path regression, the runtime spawn path must clear its own reservation when a post-spawn step throws, else the next materialization hangs forever.
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    let spawnCount = 0
    const providerSpawn = vi.fn(async () => ({ id: `pty-${++spawnCount}` }))
    setLocalPtyProvider({
      spawn: providerSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      persistPtyBinding: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn().mockImplementationOnce(() => {
        throw new Error('boom: runtime registration failed')
      }),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '55555555-5555-4555-8555-555555555555'
    const paneKey = makePaneKey('tab-runtime-reservation', leafId)
    const spawnArgs = {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: 'wt-1',
      tabId: 'tab-runtime-reservation',
      leafId,
      env: { ORCA_PANE_KEY: paneKey },
      persistHostSessionBinding: true
    }

    await expect(spawnController.spawn(spawnArgs)).rejects.toThrow('boom')

    // The reservation must be gone, so a second materialization runs a fresh provider.spawn instead of awaiting the leaked promise.
    let hangTimer: ReturnType<typeof setTimeout> | undefined
    const second = spawnController.spawn(spawnArgs)
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error('second runtime spawn hung: pane reservation leaked')),
          1000
        )
      })
    ]).finally(() => clearTimeout(hangTimer))
    expect(result.id).toEqual(expect.any(String))
    expect(providerSpawn).toHaveBeenCalledTimes(2)
  })
  it('records SSH leases for runtime-owned headless session bindings', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        connectionId?: string
        tabId?: string
        leafId?: string
        sessionId?: string
        persistHostSessionBinding?: boolean
      }): Promise<{ id: string }>
    }
    const remoteSpawn = vi.fn(async () => ({ id: 'ssh:ssh-1@@relay-pty' }))
    registerSshPtyProvider('ssh-1', {
      spawn: remoteSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    const leafId = '11111111-1111-4111-8111-111111111111'
    await spawnController.spawn({
      cols: 80,
      rows: 24,
      connectionId: 'ssh-1',
      worktreeId: 'wt-remote',
      tabId: 'tab-remote',
      leafId,
      sessionId: 'ssh:ssh-1@@relay-pty',
      persistHostSessionBinding: true
    })

    expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'ssh-1',
        ptyId: 'relay-pty',
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        state: 'attached'
      })
    )
    expect(store.persistPtyBinding).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-remote',
        tabId: 'tab-remote',
        leafId,
        ptyId: 'ssh:ssh-1@@relay-pty',
        hostAdmittedMembership: true
      },
      'ssh:ssh-1'
    )
    expect(store.persistPtyBinding.mock.invocationCallOrder[0]!).toBeLessThan(
      store.upsertSshRemotePtyLease.mock.invocationCallOrder[0]!
    )
    unregisterSshPtyProvider('ssh-1')
  })
})
