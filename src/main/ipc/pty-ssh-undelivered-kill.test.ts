import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { SSH_SESSION_EXPIRED_ERROR } from '../providers/ssh-pty-errors'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  deletePtyOwnership,
  setPtyOwnership,
  restorePtyIncarnation
} from './pty'

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

const SCOPED_PTY_ID = 'ssh:ssh-1@@pty-7'

function createKillStore() {
  return {
    markSshRemotePtyLease: vi.fn(),
    recordSshRemotePtyKillIntent: vi.fn(),
    clearSshRemotePtyKillIntent: vi.fn()
  }
}

function sshProviderStub(shutdown: () => Promise<void>) {
  return {
    shutdown: vi.fn(shutdown),
    onExit: vi.fn(() => () => {}),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => [])
  } as never
}

function installController(handlers: Map<string, never>) {
  const runtime = {
    setPtyController: vi.fn(),
    markPtyStopRequested: vi.fn(),
    markPtyLivenessUnverifiable: vi.fn(),
    onPtyExit: vi.fn()
  }
  handlers.clear()
  return { runtime }
}

describe('undelivered SSH stops', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  function install(store: ReturnType<typeof createKillStore>): {
    kill: (ptyId: string) => boolean
    stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
    markReversibleStops: (ptyIds: readonly string[]) => () => void
    runtime: ReturnType<typeof installController>['runtime']
  } {
    const { runtime } = installController(handlers as never)
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
      stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
      markReversibleStops: (ptyIds: readonly string[]) => () => void
    }
    return {
      kill: controller.kill,
      stopAndWait: controller.stopAndWait,
      markReversibleStops: controller.markReversibleStops,
      runtime
    }
  }

  // The leak: the shutdown died on the transport, the verdict is correctly `unverifiable`, and
  // before this fix nothing retried — the remote shell survived forever.
  it('records the stop when the shutdown RPC rejects with a transport failure', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {
        throw new Error('socket closed')
      })
    )
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-a')
    const { kill, runtime } = install(store)

    try {
      expect(kill(SCOPED_PTY_ID)).toBe(true)
      await vi.waitFor(() => expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalled())
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-a', attempts: 0 })
      )
      expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
        SCOPED_PTY_ID,
        'socket closed'
      )
    } finally {
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  // The offline close: no provider is registered, so the relay is never even asked. The lease is
  // tombstoned locally, and without the record the remote shell has nothing left to retire it.
  it('records the stop when no provider is registered to deliver it', async () => {
    const store = createKillStore()
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-b')
    const { kill } = install(store)

    try {
      expect(kill(SCOPED_PTY_ID)).toBe(false)
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-b' })
      )
    } finally {
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('records nothing when the shutdown RPC is delivered', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {})
    )
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-c')
    const { kill } = install(store)

    try {
      expect(kill(SCOPED_PTY_ID)).toBe(true)
      await vi.waitFor(() => expect(store.markSshRemotePtyLease).toHaveBeenCalled())
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
      // And it does not retire one either. A resolved RPC is not a death certificate — the relay
      // answers identically for a PTY it never had — so retirement is left to the replay, which
      // only acts on a live inventory. Clearing here would be the mechanism by which a still-valid
      // order is destroyed on an unconfirmed success.
      expect(store.clearSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  // Worktree sleep stops through stopAndWait and marks those stops reversible: when one does not
  // land, the pane stays live and the user keeps using it. A durable order recorded here would come
  // back on a later handshake and kill that terminal out from under them.
  it('records nothing for a reversible stopAndWait that could not be delivered', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {
        throw new Error('socket closed')
      })
    )
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-e')
    const { stopAndWait } = install(store)

    try {
      await expect(stopAndWait(SCOPED_PTY_ID, { keepHistory: true })).resolves.toBe(false)
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  // The path the UI actually takes. `window.api.pty.kill` -> `pty:kill`, a separate implementation
  // from the runtime controller, and the one #12447 describes.
  it('records the stop when the renderer pty:kill shutdown rejects', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {
        throw new Error('socket closed')
      })
    )
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-r1')
    install(store)

    try {
      await expect(handlers.get('pty:kill')!(null, { id: SCOPED_PTY_ID })).rejects.toThrow(
        'socket closed'
      )
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-r1' })
      )
    } finally {
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('records the stop when renderer pty:kill finds no provider to deliver it', async () => {
    const store = createKillStore()
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-r2')
    install(store)

    try {
      await handlers.get('pty:kill')!(null, { id: SCOPED_PTY_ID })
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-r2' })
      )
    } finally {
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  // Pane hibernation is the reversible caller on this IPC and is the only one passing keepHistory.
  it('records nothing for a renderer pty:kill that keeps history', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {
        throw new Error('socket closed')
      })
    )
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-r3')
    install(store)

    try {
      await expect(
        handlers.get('pty:kill')!(null, { id: SCOPED_PTY_ID, keepHistory: true })
      ).rejects.toThrow('socket closed')
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('records nothing while a reversible stop owns the PTY', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {
        throw new Error('socket closed')
      })
    )
    setPtyOwnership(SCOPED_PTY_ID, 'ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-f')
    const { kill, markReversibleStops } = install(store)
    const release = markReversibleStops([SCOPED_PTY_ID])

    try {
      kill(SCOPED_PTY_ID)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      release()
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('records nothing for a local PTY, which has no later host to ask', async () => {
    const store = createKillStore()
    setPtyOwnership('local-pty', null)
    restorePtyIncarnation('local-pty', 'inc-d')
    const { kill } = install(store)

    try {
      kill('local-pty')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      deletePtyOwnership('local-pty')
    }
  })

  // No incarnation means no fence, and an unfenced order can only be discarded or guessed at.
  it('records nothing when the PTY incarnation was never learned', async () => {
    const store = createKillStore()
    registerSshPtyProvider(
      'ssh-1',
      sshProviderStub(async () => {
        throw new Error(`${SSH_SESSION_EXPIRED_ERROR}-transport`)
      })
    )
    setPtyOwnership('ssh:ssh-1@@pty-8', 'ssh-1')
    const { kill } = install(store)

    try {
      kill('ssh:ssh-1@@pty-8')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      unregisterSshPtyProvider('ssh-1')
      deletePtyOwnership('ssh:ssh-1@@pty-8')
    }
  })
})
