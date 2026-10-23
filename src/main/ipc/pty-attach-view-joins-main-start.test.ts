// Layout-owner build: a window view that attaches while main starts its pane takes main's start,
// with no second provider attach (one round trip, as the window's own cold restore was).
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
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

type PaneArgs = { worktreeId: string; connectionId: string | null; tabId: string; leafId: string }
type RuntimeSpawnController = {
  claimStablePaneCreate(args: PaneArgs): () => void
  spawn(args: Record<string, unknown>): Promise<{ id: string }>
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members these spawn paths read.
const testDouble = <T>(value: unknown): T => value as T

const PANE: PaneArgs = {
  worktreeId: 'repo-1::/tmp/view-join',
  connectionId: null,
  tabId: 'tab-view-join',
  leafId: '55555555-5555-4555-8555-555555555555'
}

describe('a window view of a pane main is starting', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  /** Main starts the pane while the window's view of it waits; resolves the view's attach. */
  async function viewDuringMainStart(startResult: Record<string, unknown>) {
    const providerSpawn = vi.fn(async (opts: { sessionId?: string }) => ({
      id: opts.sessionId ?? 'pty-main',
      ...startResult
    }))
    setLocalPtyProvider(
      testDouble({
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
      })
    )
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value: RuntimeSpawnController) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_main'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(),
      seedHeadlessTerminal: vi.fn()
    }
    registerPtyHandlers(testDouble(mainWindow), testDouble(runtime))
    const main = testDouble<RuntimeSpawnController>(controller)
    const releaseClaim = main.claimStablePaneCreate(PANE)
    const view = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      ...PANE,
      sessionId: 'pty-main',
      attachOnlyView: true
    })
    await main.spawn({ cols: 80, rows: 24, cwd: '/tmp/view-join', ...PANE, sessionId: 'pty-main' })
    releaseClaim()
    return { view: await view, providerSpawn }
  }

  it('attaches to the terminal main starts, with one provider request', async () => {
    const coldRestore = { scrollback: 'restored history', cwd: '/tmp/view-join' }
    const { view, providerSpawn } = await viewDuringMainStart({ coldRestore })
    expect(view).toMatchObject({ id: 'pty-main', isReattach: true, coldRestore })
    expect(providerSpawn).toHaveBeenCalledOnce()
  })

  it("attaches as today when main's start carries no payload to paint", async () => {
    // A fresh start: nothing to paint, so the view's own attach takes the provider's snapshot.
    const { view, providerSpawn } = await viewDuringMainStart({})
    expect(view).toMatchObject({ id: 'pty-main' })
    expect(providerSpawn).toHaveBeenCalledTimes(2)
  })
})
