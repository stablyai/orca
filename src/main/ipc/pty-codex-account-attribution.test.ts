import { describe, expect, it, vi } from 'vitest'
import {
  readFileSyncMock,
  recordCodexPaneAccountMock,
  forgetCodexPaneAccountMock
} from './pty-ipc-mock-registry'
import { TEST_CODEX_HOME, TEST_CODEX_AUTH_JSON } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

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

  it('records route provenance for a process-wide CODEX_HOME', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/process/custom-codex-home'
    try {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'pty-process-home' })),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: null })
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => TEST_CODEX_HOME,
        getSettings as never
      )

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        env: { CODEX_HOME: '/process/custom-codex-home' }
      })

      expect(recordCodexPaneAccountMock).toHaveBeenCalledWith('pty-process-home', {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home',
        environmentHomeOverride: { codexHome: '/process/custom-codex-home' }
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })
  it('does not guess route provenance for a pane-local environment CODEX_HOME', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-pane-env-home' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: null })
    registerPtyHandlers(mainWindow as never, undefined, () => TEST_CODEX_HOME, getSettings as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: { CODEX_HOME: '/pane/custom-codex-home' }
    })

    expect(recordCodexPaneAccountMock).toHaveBeenCalledWith('pty-pane-env-home', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'custom-home'
    })
  })
  it('does not resume under another account when the origin auth stays unavailable', async () => {
    vi.useFakeTimers()
    const spawn = vi.fn(async () => ({ id: 'pty-must-not-spawn' }))
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('auth.json')) {
        throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
      }
      return ''
    })
    const resolveHome = vi.fn(() => '/managed/current/home')
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      resolveHome,
      (() => ({
        codexManagedAccounts: [
          { id: 'account-a', managedHomePath: '/managed/origin/home' },
          { id: 'account-b', managedHomePath: '/managed/current/home' }
        ]
      })) as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/origin/home'
        })
      }
    )

    const launch = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      command: 'codex resume session-a',
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })
    const rejection = expect(launch).rejects.toThrow(
      'The Codex account credentials for this session are temporarily unavailable. Try opening the terminal again.'
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection

    expect(resolveHome).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(recordCodexPaneAccountMock).not.toHaveBeenCalled()
  })
  it('records the origin account a resumed Codex pane is pinned to', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-resumed' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [
        { id: 'account-a', managedHomePath: '/managed/origin/home' },
        { id: 'account-b', managedHomePath: '/managed/current/home' }
      ]
    })
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      vi.fn(() => '/managed/current/home'),
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/origin/home'
        })
      }
    )
    readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })

    // Why: the resume deliberately overrides the selection, so the pane really
    // is on account-a. Recording that is what makes the restart prompt appear.
    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      ['pty-resumed', { selectionKey: 'host', accountId: 'account-a', homeRoute: 'account-home' }]
    ])
    expect(readFileSyncMock).toHaveBeenCalledWith('/managed/origin/home/auth.json', 'utf8')
    expect(forgetCodexPaneAccountMock).not.toHaveBeenCalled()
  })
  it('leaves a resumed Codex pane unattributed when no account owns its home', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-resumed' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [{ id: 'account-b', managedHomePath: '/managed/current/home' }]
    })
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      vi.fn(() => '/managed/current/home'),
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/shared-mirror/home'
        })
      }
    )

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/shared-mirror/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })

    // Why: an unowned home cannot be named, so guessing here would raise a
    // restart notice that blocks a correctly-signed-in pane's input.
    expect(recordCodexPaneAccountMock).not.toHaveBeenCalled()
    expect(forgetCodexPaneAccountMock).toHaveBeenCalledWith('pty-resumed')
  })
  // Why: the runtime controller is the CLI/relay resume path, and it repeats the
  // same recording call the ipc handler makes. Without its own coverage a revert
  // there is invisible.
  it('records the origin account for a resumed Codex pane spawned by the runtime controller', async () => {
    type RuntimeSpawnController = {
      spawn(args: Record<string, unknown>): Promise<{ id: string }>
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-runtime-resumed' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [
        { id: 'account-a', managedHomePath: '/managed/origin/home' },
        { id: 'account-b', managedHomePath: '/managed/current/home' }
      ]
    })
    handlers.clear()
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      vi.fn(() => '/managed/current/home'),
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/origin/home'
        })
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController
    readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)

    await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-runtime',
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/origin/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })

    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      [
        'pty-runtime-resumed',
        { selectionKey: 'host', accountId: 'account-a', homeRoute: 'account-home' }
      ]
    ])
    expect(readFileSyncMock).toHaveBeenCalledWith('/managed/origin/home/auth.json', 'utf8')
    expect(forgetCodexPaneAccountMock).not.toHaveBeenCalled()
  })
  it('leaves a runtime-controller resumed Codex pane unattributed when no account owns its home', async () => {
    type RuntimeSpawnController = {
      spawn(args: Record<string, unknown>): Promise<{ id: string }>
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-runtime-resumed' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const getSettings = vi.fn().mockReturnValue({
      activeCodexManagedAccountId: 'account-b',
      codexManagedAccounts: [{ id: 'account-b', managedHomePath: '/managed/current/home' }]
    })
    handlers.clear()
    const resolveHome = vi.fn(() => '/managed/shared-mirror/home')
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      resolveHome,
      getSettings as never,
      undefined,
      undefined,
      {
        prepareCodexSessionResume: async () => ({
          outcome: 'resume' as const,
          codexHomePath: '/managed/shared-mirror/home',
          reconcileSharedRuntimeAuth: true
        })
      }
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController

    await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-runtime',
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: '/managed/shared-mirror/home/sessions/2026/07/20/rollout-a.jsonl'
      }
    })

    expect(resolveHome).toHaveBeenCalledTimes(1)
    expect(recordCodexPaneAccountMock).not.toHaveBeenCalled()
    expect(forgetCodexPaneAccountMock).toHaveBeenCalledWith('pty-runtime-resumed')
  })
})
