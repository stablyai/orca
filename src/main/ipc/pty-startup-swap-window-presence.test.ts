import { describe, expect, it, vi } from 'vitest'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'
import { ptyOwnership } from './pty/provider/ownership-state'

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

// During the cold-start daemon swap the installed local provider is still the plain
// in-process LocalPtyProvider; it does not own daemon-restored PTY ids, so its
// "no PTY" is fabricated, not observed. A confident false here tears down live
// panes (shouldReconcileMissingSession reconciles ONLY on false) and blocks
// input-undeliverable remount recovery. These suites pin: while the swap is in
// flight the presence answer is deferred (IPC) or unverifiable-null (sync), and
// the post-swap owner's answer is the one that lands.
describe('registerPtyHandlers daemon-swap-window presence', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  const registerWithStartupBarrier = (
    barrier: Promise<void>,
    runtime?: Record<string, unknown>
  ): void => {
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { awaitLocalPtyProviderStartup: () => barrier }
    )
  }

  const installRuntimeControllerWithBarrier = (
    barrier: Promise<void>
  ): { hasPty: (ptyId: string) => boolean | null } => {
    let controller: { hasPty: (ptyId: string) => boolean | null } | undefined
    registerWithStartupBarrier(barrier, {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    })
    if (!controller) {
      throw new Error('runtime controller was not installed')
    }
    return controller
  }

  it('pty:hasPty defers a restored daemon id until the provider swap lands instead of answering a pre-swap false', async () => {
    const barrier = makeDeferred()
    registerWithStartupBarrier(barrier.promise)

    const pending = Promise.resolve(
      handlers.get('pty:hasPty')!(null, { id: 'daemon-restored-pty' })
    ) as Promise<boolean | null>
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    // Pre-fix this has already resolved false — the pre-swap LocalPtyProvider
    // answered for a PTY it does not own, and the renderer reconciler treats
    // exactly that false as authority to tear the pane down.
    expect(settled).toBe(false)

    installDaemonTestProvider({ hasPty: (id: string) => id === 'daemon-restored-pty' })
    barrier.resolve()

    await expect(pending).resolves.toBe(true)
  })

  it('pty:hasPty answers SSH-owned ids from their provider without waiting on the local swap', async () => {
    const barrier = makeDeferred()
    const sshHasPty = vi.fn((id: string) => id === 'ssh:ssh-1@@pty-2')
    registerSshPtyProvider('ssh-1', { hasPty: sshHasPty } as never)
    registerWithStartupBarrier(barrier.promise)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'ssh:ssh-1@@pty-2' })).resolves.toBe(true)
    expect(sshHasPty).toHaveBeenCalledWith('ssh:ssh-1@@pty-2')
  })

  it('runtime controller hasPty answers null, not false, while the local provider swap is in flight', async () => {
    const barrier = makeDeferred()
    const controller = installRuntimeControllerWithBarrier(barrier.promise)

    // Pre-fix: the pre-swap LocalPtyProvider's ptyProcesses.has() answers a
    // confident false for a daemon-owned id. terminal.list then records an
    // observed absence (verdict forgotten) instead of unverifiable.
    expect(controller.hasPty('daemon-restored-pty')).toBe(null)

    installDaemonTestProvider({ hasPty: (id: string) => id === 'daemon-restored-pty' })
    barrier.resolve()

    await vi.waitFor(() => {
      expect(controller.hasPty('daemon-restored-pty')).toBe(true)
    })
  })

  it('runtime controller hasPty never answers a paired-runtime handle from the local registry', () => {
    // No startup barrier: the remote-handle guard must hold on its own, not
    // ride on the swap-window gate. Same routing hazard the async probe and
    // pty:hasPty already guard — no locally routed provider can
    // authoritatively answer for a remote host's PTY, so remote-scoped ids
    // stay unknown, never absent.
    let controller: { hasPty: (ptyId: string) => boolean | null } | undefined
    registerPtyHandlers(
      mainWindow as never,
      {
        setPtyController: vi.fn((next) => {
          controller = next
        }),
        registerPty: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      } as never
    )

    expect(controller?.hasPty('remote:environment@@pty-1')).toBe(null)
  })

  it('runtime controller hasPty answers SSH-owned ids without waiting on the local swap', () => {
    const barrier = makeDeferred()
    const sshHasPty = vi.fn((id: string) => id === 'ssh-live-pty')
    registerSshPtyProvider('ssh-1', { hasPty: sshHasPty } as never)
    ptyOwnership.set('ssh-live-pty', 'ssh-1')
    try {
      const controller = installRuntimeControllerWithBarrier(barrier.promise)

      expect(controller.hasPty('ssh-live-pty')).toBe(true)
      expect(sshHasPty).toHaveBeenCalledWith('ssh-live-pty')
    } finally {
      ptyOwnership.delete('ssh-live-pty')
    }
  })

  it('pty:inspectProcess defers a restored daemon id until the provider swap lands instead of answering from the non-owning provider', async () => {
    const barrier = makeDeferred()
    registerWithStartupBarrier(barrier.promise)

    const pending = Promise.resolve(
      handlers.get('pty:inspectProcess')!(null, { id: 'daemon-restored-pty' })
    )
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // Pre-fix this has already resolved — the pre-swap LocalPtyProvider was
    // consulted about a PTY it does not own. Its non-ownership happens to read
    // as unavailable today only because the inspection funnel consults hasPty
    // before the provider's own inspection; completion-sensitive evidence must
    // come from the post-swap owner, not from that internal ordering.
    expect(settled).toBe(false)

    installDaemonTestProvider({
      hasPty: (id: string) => id === 'daemon-restored-pty',
      inspectProcess: vi.fn(async () => ({
        foregroundProcess: 'codex',
        hasChildProcesses: true
      }))
    })
    barrier.resolve()

    await expect(pending).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
  })

  it('pty:inspectProcess answers SSH-owned ids from their provider without waiting on the local swap', async () => {
    const barrier = makeDeferred()
    const sshInspect = vi.fn(async () => ({
      foregroundProcess: 'ssh-codex',
      hasChildProcesses: true
    }))
    registerSshPtyProvider('ssh-1', {
      hasPty: (id: string) => id === 'ssh:ssh-1@@pty-2',
      inspectProcess: sshInspect
    } as never)
    registerWithStartupBarrier(barrier.promise)

    await expect(
      handlers.get('pty:inspectProcess')!(null, { id: 'ssh:ssh-1@@pty-2' })
    ).resolves.toEqual({ foregroundProcess: 'ssh-codex', hasChildProcesses: true })
    expect(sshInspect).toHaveBeenCalledWith('ssh:ssh-1@@pty-2')
  })

  it('keeps the in-process provider authoritative when no startup barrier is configured', async () => {
    // Headless/orcad installs the daemon before registerPtyHandlers and passes
    // no barrier; the installed provider is then the sole owner (#12393) and
    // its false stays an observed absence.
    let controller: { hasPty: (ptyId: string) => boolean | null } | undefined
    registerPtyHandlers(
      mainWindow as never,
      {
        setPtyController: vi.fn((next) => {
          controller = next
        }),
        registerPty: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      } as never
    )

    expect(controller?.hasPty('never-spawned-pty')).toBe(false)
    await expect(handlers.get('pty:hasPty')!(null, { id: 'never-spawned-pty' })).resolves.toBe(
      false
    )
    // The sole owner's inspection answer stays immediate too: with no swap in
    // flight there is no window in which its word could be fabricated.
    await expect(
      handlers.get('pty:inspectProcess')!(null, { id: 'never-spawned-pty' })
    ).resolves.toEqual({ foregroundProcess: null, hasChildProcesses: false, unavailable: true })
  })
})
