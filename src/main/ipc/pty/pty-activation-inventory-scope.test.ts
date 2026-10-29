import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { installPtyInspectIpcHandlers } from './ipc/inspect'
import { setRuntimeDesktopSurface } from '../../runtime/runtime-desktop-surface'
import type { PtyProcessInfo } from '../../providers/pty-process-info'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('scoped activation PTY inventory', () => {
  const { handlers, mainWindowIpcEvent, installDaemonTestProvider } = setupPtyIpcSuite()

  function install() {
    const localList = vi.fn(async (): Promise<PtyProcessInfo[]> => [
      { id: 'local', cwd: '/', title: 'shell' }
    ])
    installDaemonTestProvider({ listProcesses: localList })
    const startup = vi.fn(async () => {})
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: startup })
    const list = (scope?: unknown) => handlers.get('pty:listSessions')!(null, scope)
    return { localList, startup, list }
  }

  it('waits for local startup for a local scope', async () => {
    const { list, localList, startup } = install()
    let release!: () => void
    startup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = list({ connectionId: null })
    expect(localList).not.toHaveBeenCalled()
    release()
    await pending
    expect(localList).toHaveBeenCalledOnce()
  })

  it('fails an SSH scope and never substitutes the local inventory', async () => {
    const { list, localList } = install()
    await expect(list({ connectionId: 'host-3' })).rejects.toThrow('No PTY provider')
    expect(localList).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { connectionId: '' },
    { connectionId: 42 },
    { connectionId: null, includeUnrouted: 'yes' },
    { connectionId: null, includeUnrouted: true }
  ])('rejects malformed scope %j before inventory admission', async (scope) => {
    const { list, localList } = install()
    await expect(list(scope)).rejects.toThrow('invalid_pty_session_list_scope')
    expect(localList).not.toHaveBeenCalled()
  })

  it.each([
    { wslDistro: null, shellPath: 'cmd.exe' },
    { wslDistro: 'Debian', shellPath: 'wsl.exe' },
    {}
  ])('lists only the local inventory and preserves owner facts %j', async (facts) => {
    const { list, localList } = install()
    localList.mockResolvedValueOnce([{ id: 'local', cwd: '/', title: 'shell', ...facts }])
    expect(await list()).toEqual([
      {
        id: 'local',
        cwd: '/',
        title: 'shell',
        fencedTermination: false,
        agentOwnership: 'unknown',
        ...facts
      }
    ])
    expect(localList).toHaveBeenCalledOnce()
  })

  it('shows reused ids in diagnostics without borrowing another generation’s stop capability', async () => {
    const processes: PtyProcessInfo[] = [
      { id: 'reused', incarnationId: 'A', rootProcessId: 101, cwd: '/', title: 'old' },
      { id: 'reused', incarnationId: 'B', rootProcessId: 202, cwd: '/', title: 'new' },
      { id: 'unrelated', incarnationId: 'C', cwd: '/', title: 'shell' }
    ]
    const localList = vi.fn(async () => processes)
    installDaemonTestProvider({
      listProcesses: localList,
      supportsFencedTermination: () => true,
      providesAgentSessionOwnerListings: () => true
    })
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: () => undefined })
    setRuntimeDesktopSurface({
      showNotification: () => false,
      findWindowById: () => null,
      onIpc: () => {},
      removeIpcListener: () => {},
      isResourceViewVisible: () => true
    })
    try {
      const sessions: unknown = await handlers.get('pty:listSessions')!(
        mainWindowIpcEvent,
        { connectionId: null, includeUnrouted: true },
        { resourceManagerView: true }
      )
      expect(localList).toHaveBeenCalledExactlyOnceWith({ includeUnrouted: true })
      expect(sessions).toEqual([
        expect.objectContaining({
          id: 'reused',
          incarnationId: 'A',
          rootProcessId: 101,
          fencedTermination: false,
          agentOwnership: 'unknown'
        }),
        expect.objectContaining({
          id: 'reused',
          incarnationId: 'B',
          rootProcessId: 202,
          fencedTermination: false,
          agentOwnership: 'unknown'
        }),
        expect.objectContaining({
          id: 'unrelated',
          fencedTermination: true,
          agentOwnership: 'absent'
        })
      ])
      localList.mockClear()
      await handlers.get('pty:listSessions')!(null, { connectionId: null })
      expect(localList).toHaveBeenCalledExactlyOnceWith()
    } finally {
      setRuntimeDesktopSurface(null)
    }
  })

  it('keeps Resources on the routed incarnation while the PTY view sees every daemon', async () => {
    const current: PtyProcessInfo = {
      id: 'reused',
      incarnationId: 'A',
      cwd: '/current',
      title: 'current',
      inventorySourceId: 'current-daemon',
      routed: false
    }
    const legacy: PtyProcessInfo = {
      id: 'reused',
      incarnationId: 'B',
      cwd: '/legacy',
      title: 'legacy',
      inventorySourceId: 'legacy-daemon',
      routed: true
    }
    const localList = vi.fn(async (opts?: { includeUnrouted?: boolean }) =>
      opts?.includeUnrouted ? [current, legacy] : [legacy]
    )
    installDaemonTestProvider({ listProcesses: localList })
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: () => undefined })
    setRuntimeDesktopSurface({
      showNotification: () => false,
      findWindowById: () => null,
      onIpc: () => {},
      removeIpcListener: () => {},
      isResourceViewVisible: () => true
    })
    try {
      const list = handlers.get('pty:listSessions')!
      await expect(
        list(mainWindowIpcEvent, undefined, { resourceManagerView: true })
      ).resolves.toEqual([expect.objectContaining({ incarnationId: 'B' })])
      expect(localList).toHaveBeenLastCalledWith()
      await expect(
        list(
          mainWindowIpcEvent,
          { connectionId: null, includeUnrouted: true },
          { resourceManagerView: true }
        )
      ).resolves.toEqual([
        expect.objectContaining({ incarnationId: 'A', routed: false }),
        expect.objectContaining({ incarnationId: 'B', routed: true })
      ])
    } finally {
      setRuntimeDesktopSurface(null)
    }
  })

  it('retains same-id legacy processes from distinct diagnostic sources', async () => {
    installDaemonTestProvider({
      listProcesses: async () => [
        {
          id: 'reused',
          cwd: '/first',
          title: 'shell',
          inventorySourceId: 'first',
          rootProcessId: 101
        },
        {
          id: 'reused',
          cwd: '/second',
          title: 'shell',
          inventorySourceId: 'second',
          rootProcessId: 202
        }
      ]
    })
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: () => undefined })
    setRuntimeDesktopSurface({
      showNotification: () => false,
      findWindowById: () => null,
      onIpc: () => {},
      removeIpcListener: () => {},
      isResourceViewVisible: () => true
    })
    try {
      await expect(
        handlers.get('pty:listSessions')!(
          mainWindowIpcEvent,
          { connectionId: null, includeUnrouted: true },
          { resourceManagerView: true }
        )
      ).resolves.toEqual([
        expect.objectContaining({ inventorySourceId: 'first', rootProcessId: 101 }),
        expect.objectContaining({ inventorySourceId: 'second', rootProcessId: 202 })
      ])
    } finally {
      setRuntimeDesktopSurface(null)
    }
  })
})
