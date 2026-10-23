// Layout-owner build: a window view that attaches while main starts its pane takes main's start,
// with no second provider attach (one round trip, as the window's own cold restore was).
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { TerminalSurfaceIndex } from '../runtime/terminal/surface/terminal-surface-index'
import { createPaneBindingStore } from './pty-launch-race-test-fixture'
import {
  pendingRuntimePaneCreatesByOwnerKey,
  makePaneSpawnReservationKey
} from './pty/pane/spawn-reservation'
import { makePaneKey } from '../../shared/stable-pane-id'

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
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const providerSpawn = vi.fn(async (opts: { sessionId?: string; attachOnly?: boolean }) => {
      await gate
      return {
        id: opts.sessionId ?? 'pty-main',
        incarnationId: 'main-inc',
        ...(opts.attachOnly ? { isReattach: true } : {}),
        ...startResult
      }
    })
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
    const bindingStore = createPaneBindingStore()
    type WriteListener = Parameters<NonNullable<RuntimeStore['onWorkspaceSessionWritten']>>[0]
    const written = new Set<WriteListener>()
    const notifyWritten = (): void => {
      for (const listener of written) {
        listener('local')
      }
    }
    const store = {
      ...bindingStore,
      getSettings: () => ({}),
      getWorkspaceSessionHostIds: (): ReturnType<
        NonNullable<RuntimeStore['getWorkspaceSessionHostIds']>
      > => ['local'],
      setWorkspaceSession: (...args: Parameters<typeof bindingStore.setWorkspaceSession>) => {
        bindingStore.setWorkspaceSession(...args)
        notifyWritten()
      },
      persistPtyBinding: async (...args: Parameters<typeof bindingStore.persistPtyBinding>) => {
        const persisted = await bindingStore.persistPtyBinding(...args)
        if (persisted) {
          notifyWritten()
        }
        return persisted
      },
      onWorkspaceSessionWritten: (listener: WriteListener) => {
        written.add(listener)
        return () => written.delete(listener)
      }
    }
    const runtime = new OrcaRuntimeService()
    Object.assign(runtime, {
      store,
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: PANE.worktreeId,
        path: '/tmp/view-join',
        connectionId: null
      }),
      resolveAgentTerminalCreateOptions: async (_workspace: unknown, opts: unknown) => opts,
      resolveWorkspaceTerminalStartupCwd: () => '/tmp/view-join'
    })
    registerPtyHandlers(
      testDouble(mainWindow),
      runtime,
      undefined,
      undefined,
      undefined,
      testDouble(store)
    )
    const mainSurfaces = new TerminalSurfaceIndex({
      reads: () => runtime.workspaceLayoutReads,
      hostIds: () => store.getWorkspaceSessionHostIds(),
      homeHostId: (key) => runtime['tryGetWorkspaceSessionHostIdForWorktree'](key),
      generatedTitlesEnabled: () => false,
      onChanged: () => {}
    })
    const registerPty = runtime.registerPty.bind(runtime)
    const registrations = vi.spyOn(runtime, 'registerPty').mockImplementation((...args) => {
      expect(mainSurfaces.surfaces().leaves.find((leaf) => leaf.ptyId === args[0])).toMatchObject({
        worktreeId: PANE.worktreeId,
        tabId: PANE.tabId,
        leafId: PANE.leafId
      })
      registerPty(...args)
    })
    const started = runtime.createTerminal(`id:${PANE.worktreeId}`, {
      tabId: PANE.tabId,
      leafId: PANE.leafId,
      sessionId: 'pty-main',
      presentation: 'background'
    })
    await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledOnce())
    const key = makePaneSpawnReservationKey(
      PANE.worktreeId,
      null,
      makePaneKey(PANE.tabId, PANE.leafId)
    )!
    const pending = pendingRuntimePaneCreatesByOwnerKey.get(key)!
    const barrier = pending.promise
    // Deliver the captured result after the producer's second registration settles.
    const settled = Promise.all([barrier, started]).then(([result]) => result)
    const waiting = vi.fn(() => settled)
    Object.defineProperty(pending, 'promise', { get: waiting })
    const view = handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      ...PANE,
      sessionId: 'pty-main',
      attachOnlyView: true
    })
    const completed = Promise.all([started, view])
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
    release()
    const [, attached] = await completed
    expect(registrations.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(pending.operation?.acquisition?.reservation.outcome?.kind).toBe('committed')
    expect(pendingRuntimePaneCreatesByOwnerKey.has(key)).toBe(false)
    return { view: attached, providerSpawn }
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
