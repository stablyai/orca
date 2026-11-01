import { describe, expect, it, vi } from 'vitest'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'

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

type PresenceController = {
  hasPty: (ptyId: string) => boolean | null
  getPtyAvailability: (ptyId: string) => boolean | null
}

// During daemon startup, local-provider absence cannot prove restored PTYs dead; await the owning provider or report unknown.
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

  const installRuntimeControllerWithBarrier = (barrier: Promise<void>): PresenceController => {
    let controller: PresenceController | undefined
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
    // Defer absence until the restored session's owning provider is installed.
    expect(settled).toBe(false)

    installDaemonTestProvider({ hasPty: (id: string) => id === 'daemon-restored-pty' })
    barrier.resolve()

    await expect(pending).resolves.toBe(true)
  })

  it('runtime controller hasPty answers null, not false, while the local provider swap is in flight', async () => {
    const barrier = makeDeferred()
    const controller = installRuntimeControllerWithBarrier(barrier.promise)

    // The pre-swap local provider cannot authoritatively answer for a daemon-owned PTY.
    expect(controller.hasPty('daemon-restored-pty')).toBe(null)
    expect(controller.getPtyAvailability('daemon-restored-pty')).toBe(null)

    installDaemonTestProvider({
      hasPty: (id: string) => id === 'daemon-restored-pty',
      getPtyAvailability: () => false
    })
    barrier.resolve()

    await vi.waitFor(() => {
      expect(controller.hasPty('daemon-restored-pty')).toBe(true)
      expect(controller.getPtyAvailability('daemon-restored-pty')).toBe(false)
    })
  })

  it('runtime controller hasPty never answers a paired-runtime handle from the local registry', () => {
    // Exercise remote ownership without a startup barrier; local-provider silence must still remain unknown.
    let controller: PresenceController | undefined
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
    expect(controller?.getPtyAvailability('remote:environment@@pty-1')).toBe(null)
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
    // Completion-sensitive inspection must wait for the owning provider, regardless of local hasPty ordering.
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

  it('keeps the in-process provider authoritative when no startup barrier is configured', async () => {
    // Headless hosts install their sole provider before registration; its absence is authoritative (#12393).
    let controller: PresenceController | undefined
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
    await expect(
      handlers.get('pty:inspectProcess')!(null, { id: 'never-spawned-pty' })
    ).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'terminal_gone'
    })
  })
})
