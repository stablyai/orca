import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { installPtyInspectIpcHandlers } from './pty/ipc/inspect'

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

describe('scoped activation PTY inventory', () => {
  const { handlers, installDaemonTestProvider } = setupPtyIpcSuite()

  function install() {
    const localList = vi.fn(async () => [{ id: 'local', cwd: '/', title: 'shell' }])
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

  it.each([null, {}, { connectionId: '' }, { connectionId: 42 }])(
    'rejects malformed scope %j before inventory admission',
    async (scope) => {
      const { list, localList } = install()
      await expect(list(scope)).rejects.toThrow('invalid_pty_session_list_scope')
      expect(localList).not.toHaveBeenCalled()
    }
  )

  it('lists only the local inventory without a scope', async () => {
    const { list, localList } = install()
    expect(await list()).toHaveLength(1)
    expect(localList).toHaveBeenCalledOnce()
  })
})
