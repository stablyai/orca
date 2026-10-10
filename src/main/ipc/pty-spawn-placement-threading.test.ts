import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import { registerPtyHandlers } from './pty'

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

const LEAF = '33333333-3333-4333-8333-333333333333'
const PARENT = '44444444-4444-4444-8444-444444444444'
const WORKTREE = 'repo-1::/tmp/placement'
const SPLIT: TerminalPanePlacement = {
  kind: 'split',
  parentLeafId: PARENT,
  direction: 'horizontal'
}

type RuntimeSpawnController = {
  spawn(args: Record<string, unknown>): Promise<{ id: string }>
}

describe('pty spawn placement threading', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  function register(): {
    store: { persistPtyBinding: ReturnType<typeof vi.fn> }
    controller: () => RuntimeSpawnController
  } {
    const store = { persistPtyBinding: vi.fn(async () => true) }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_trusted'),
      preAllocateHandleForPty: vi.fn(() => 'term_trusted'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn reads only the window, runtime and store members these fakes define.
    const args = [
      mainWindow,
      runtime,
      undefined,
      undefined,
      undefined,
      store
    ] as unknown as Parameters<typeof registerPtyHandlers>
    registerPtyHandlers(...args)
    return {
      store,
      controller: () => {
        if (!controller) {
          throw new Error('runtime controller not installed')
        }
        return controller
      }
    }
  }

  async function ipcSpawn(extra: Record<string, unknown>): Promise<void> {
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: WORKTREE,
      tabId: 'tab-placement',
      leafId: LEAF,
      env: { ORCA_TAB_ID: 'tab-placement', ORCA_WORKTREE_ID: WORKTREE },
      ...extra
    })
  }

  it('passes a valid renderer placement to the binding write', async () => {
    const { store } = register()
    await ipcSpawn({ placement: SPLIT })
    expect(store.persistPtyBinding).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-placement', leafId: LEAF, placement: SPLIT })
    )
  })

  it('keeps an old client request (no placement) byte-for-byte as before', async () => {
    const { store } = register()
    await ipcSpawn({})
    expect(store.persistPtyBinding).toHaveBeenCalledOnce()
    expect(store.persistPtyBinding.mock.calls[0]).toEqual([
      {
        worktreeId: WORKTREE,
        tabId: 'tab-placement',
        leafId: LEAF,
        ptyId: expect.any(String),
        incarnationId: expect.any(String),
        startupCwd: '/tmp',
        origin: 'spawn'
      }
    ])
  })

  it('drops a malformed or future-kind placement instead of failing the spawn', async () => {
    const { store } = register()
    await ipcSpawn({ placement: { kind: 'floating-window', anchor: 'x' } })
    await ipcSpawn({ placement: { kind: 'split', parentLeafId: 'pane-1', direction: 'vertical' } })
    expect(store.persistPtyBinding).toHaveBeenCalledTimes(2)
    for (const [binding] of store.persistPtyBinding.mock.calls) {
      expect(binding).not.toHaveProperty('placement')
    }
  })

  it('passes a main runtime spawn placement through the host-admitted binding', async () => {
    const { store, controller } = register()
    await controller().spawn({
      cols: 80,
      rows: 24,
      worktreeId: WORKTREE,
      tabId: 'tab-runtime',
      leafId: LEAF,
      env: { ORCA_PANE_KEY: makePaneKey('tab-runtime', LEAF) },
      persistHostSessionBinding: true,
      placement: SPLIT
    })
    expect(store.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: WORKTREE,
      tabId: 'tab-runtime',
      leafId: LEAF,
      ptyId: expect.any(String),
      incarnationId: expect.any(String),
      hostAdmittedMembership: true,
      placement: SPLIT,
      origin: 'spawn'
    })
  })
})
