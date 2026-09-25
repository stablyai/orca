import { describe, expect, it, vi } from 'vitest'
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

// Why: the structured native-chat handoff proves the resumed TUI's identity from the
// spawn reply's pid. When the runtime-controller reply dropped it, every claimed
// structured resume threw `The resumed terminal did not publish a process identity.`
// and closed the PTY it had just launched.
describe('runtime controller spawn reply', () => {
  const { mainWindow } = setupPtyIpcSuite()

  function installProvider(pid: number | null): void {
    setLocalPtyProvider({
      spawn: vi.fn(async (opts: { sessionId?: string }) => ({
        id: opts.sessionId ?? 'runtime-pty',
        ...(pid === null ? {} : { pid })
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
  }

  function installController(): { spawn: (args: Record<string, unknown>) => Promise<unknown> } {
    let controller: { spawn: (args: Record<string, unknown>) => Promise<unknown> } | undefined
    const runtime = {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    if (!controller) {
      throw new Error('runtime controller was not installed')
    }
    return controller
  }

  it('forwards the provider pid so the caller can prove process identity', async () => {
    installProvider(4242)
    const reply = (await installController().spawn({
      sessionId: 'runtime-pid-forwarded',
      cols: 120,
      rows: 40
    })) as { pid?: number }

    expect(reply.pid).toBe(4242)
  })

  it('omits pid when the provider could not publish one', async () => {
    installProvider(null)
    const reply = (await installController().spawn({
      sessionId: 'runtime-pid-absent',
      cols: 120,
      rows: 40
    })) as { pid?: number }

    expect(reply.pid).toBeUndefined()
  })
})
