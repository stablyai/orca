import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { IPtyProvider } from '../providers/types'
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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members the kill paths read.
const testDouble = <T>(value: unknown): T => value as T

const PTY_ID = 'wt-1@@0a1b2c3d'
const TAB_ID = 'tab-1'
const LEAF_ID = '3f0c6a52-5d0e-4a8e-9c1b-2b7e4f5a6c7d'

function localProvider(shutdown: IPtyProvider['shutdown']) {
  return {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown,
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
  }
}

function storeWithSavedPanes(incarnationsByLeafId: Record<string, string>) {
  const leafIds = Object.keys(incarnationsByLeafId)
  return {
    getWorkspaceSession: () => ({
      tabsByWorktree: { 'wt-1': [{ id: TAB_ID, worktreeId: 'wt-1', ptyId: PTY_ID }] },
      terminalLayoutsByTabId: {
        [TAB_ID]: { ptyIdsByLeafId: Object.fromEntries(leafIds.map((leaf) => [leaf, PTY_ID])) }
      },
      terminalPtyIncarnationsByPaneKey: Object.fromEntries(
        leafIds.map((leaf) => [`${TAB_ID}:${leaf}`, incarnationsByLeafId[leaf]])
      )
    }),
    markSshRemotePtyLease: vi.fn()
  }
}

describe('closing a restored local pane that never reconnected this run', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  function register(
    store: ReturnType<typeof storeWithSavedPanes>,
    runtime?: { setPtyController: ReturnType<typeof vi.fn> }
  ): void {
    registerPtyHandlers(
      testDouble(mainWindow),
      testDouble(runtime),
      undefined,
      undefined,
      undefined,
      testDouble(store)
    )
  }

  it('routes the stop by the incarnation its tab saved', async () => {
    const shutdown = vi.fn(async () => undefined)
    setLocalPtyProvider(testDouble(localProvider(shutdown)))
    register(storeWithSavedPanes({ [LEAF_ID]: 'incarnation-saved' }))

    await handlers.get('pty:kill')!(null, { id: PTY_ID })

    expect(shutdown).toHaveBeenCalledWith(PTY_ID, {
      immediate: true,
      keepHistory: false,
      expectedIncarnationId: 'incarnation-saved'
    })
  })

  it('routes runtime and CLI stops by the same saved incarnation', async () => {
    const shutdown = vi.fn(async () => undefined)
    setLocalPtyProvider(testDouble(localProvider(shutdown)))
    const runtime = { setPtyController: vi.fn(), onPtyExit: vi.fn() }
    register(storeWithSavedPanes({ [LEAF_ID]: 'incarnation-saved' }), runtime)
    const controller = testDouble<{
      kill: (ptyId: string) => boolean
      stopAndWait: (ptyId: string) => Promise<boolean>
    }>(runtime.setPtyController.mock.calls[0]?.[0])

    await controller.stopAndWait(PTY_ID)
    expect(controller.kill(PTY_ID)).toBe(true)

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(2))
    expect(shutdown).toHaveBeenNthCalledWith(1, PTY_ID, {
      immediate: true,
      keepHistory: false,
      expectedIncarnationId: 'incarnation-saved'
    })
    expect(shutdown).toHaveBeenNthCalledWith(2, PTY_ID, {
      immediate: false,
      expectedIncarnationId: 'incarnation-saved'
    })
  })

  it('sends no identity when two saved panes disagree about it', async () => {
    const shutdown = vi.fn(async () => undefined)
    setLocalPtyProvider(testDouble(localProvider(shutdown)))
    register(
      storeWithSavedPanes({
        [LEAF_ID]: 'incarnation-a',
        '9b2d7c41-0e3f-4c6a-8d5b-1a2f3e4d5c6b': 'incarnation-b'
      })
    )

    await handlers.get('pty:kill')!(null, { id: PTY_ID })

    expect(shutdown).toHaveBeenCalledWith(PTY_ID, { immediate: true, keepHistory: false })
  })
})
