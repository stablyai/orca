import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import {
  closeLegacyRelayPane,
  installLegacyRelayBridge
} from '../../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { stopRendererOwnedPty, type PtyKillIpcDeps } from '../ipc/renderer-kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { killPtyFromRuntimeController, stopAndWaitPtyFromRuntimeController } from './kill'

const TARGET = 'ssh-box'
const lease: SshRemotePtyLease = {
  targetId: TARGET,
  ptyId: 'pty2:epoch:1',
  tabId: 'tab-1',
  state: 'detached',
  createdAt: 1,
  updatedAt: 1
}

describe('a generic kill of a terminal an older relay still runs', () => {
  it('leaves its lease to the bridge instead of tombstoning a shell it never stopped', () => {
    const retireLease = vi.fn()
    installLegacyRelayBridge({
      leases: () => [lease],
      retireLease,
      recordStop: vi.fn(),
      // Disconnected: the bridge can only record the stop for the next connect.
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const finishPtyShutdown = vi.fn()
    const deps = {
      runtime: null,
      store: null,
      getLocalPtyProviderStartupPromise: () => null,
      shutdownProviderAndDetectExit: vi.fn(),
      finishPtyShutdown,
      retiredRejectedPtyIds: new Set<string>()
    }
    const accepted = killPtyFromRuntimeController(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch returns before reading any other dep.
      deps as unknown as PtyRuntimeControllerDeps,
      toAppSshPtyId(TARGET, lease.ptyId)
    )
    expect(accepted).toBe(true)
    expect(finishPtyShutdown).not.toHaveBeenCalled()
    expect(deps.shutdownProviderAndDetectExit).not.toHaveBeenCalled()
    expect(retireLease).not.toHaveBeenCalled()
    installLegacyRelayBridge(null)
  })
})

describe('a tab close of a terminal an older relay still runs', () => {
  it('hands the stop to the bridge instead of tombstoning the lease the bridge needs', async () => {
    const leases: SshRemotePtyLease[] = [{ ...lease }]
    const store = {
      markSshRemotePtyLease: vi.fn((_target: string, relayPtyId: string) => {
        for (const row of leases) {
          if (row.ptyId === relayPtyId) {
            row.state = 'terminated'
          }
        }
      })
    }
    installLegacyRelayBridge({
      leases: () => leases,
      retireLease: vi.fn(),
      recordStop: vi.fn(),
      // Disconnected, so the SSH provider is unregistered: the bridge records the stop.
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    const deps = {
      store,
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit: vi.fn(),
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch reads only these deps.
    await stopRendererOwnedPty(deps as unknown as PtyKillIpcDeps, { id: ptyId })
    expect(store.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(deps.shutdownProviderAndDetectExit).not.toHaveBeenCalled()
    // The transport's own close that follows still reaches a pending stop, not `not-bridged`.
    await expect(closeLegacyRelayPane(ptyId)).resolves.toEqual({ status: 'unverifiable' })
    installLegacyRelayBridge(null)
  })

  it('refuses a hibernation stop without recording a stop that would outlive it', async () => {
    const recordStop = vi.fn()
    const store = { markSshRemotePtyLease: vi.fn() }
    installLegacyRelayBridge({
      leases: () => [lease],
      retireLease: vi.fn(),
      recordStop,
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const deps = {
      store,
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit: vi.fn(),
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch reads only these deps.
      stopRendererOwnedPty(deps as unknown as PtyKillIpcDeps, {
        id: toAppSshPtyId(TARGET, lease.ptyId),
        keepHistory: true
      })
    ).rejects.toThrow('legacy_relay_bridged_pty_cannot_sleep')
    expect(recordStop).not.toHaveBeenCalled()
    expect(store.markSshRemotePtyLease).not.toHaveBeenCalled()
    installLegacyRelayBridge(null)
  })
})

describe('a stop-and-wait of a terminal an older relay still runs', () => {
  function install(recordStop = vi.fn(), runtime: unknown = null) {
    installLegacyRelayBridge({
      leases: () => [lease],
      retireLease: vi.fn(),
      recordStop,
      // Disconnected, so no SSH provider is registered for the target.
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const deps = {
      runtime,
      store: null,
      getLocalPtyProviderStartupPromise: () => null,
      shutdownProviderAndDetectExit: vi.fn(),
      finishPtyShutdown: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch reads only these deps.
    return deps as unknown as PtyRuntimeControllerDeps & {
      finishPtyShutdown: ReturnType<typeof vi.fn>
    }
  }

  it('records the stop with the bridge instead of tombstoning its lease (CLI close, worktree delete)', async () => {
    const recordStop = vi.fn()
    const deps = install(recordStop)
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    await expect(
      stopAndWaitPtyFromRuntimeController(deps, ptyId, { deadlineMs: Date.now() + 1_000 })
    ).resolves.toBe(false)
    expect(deps.finishPtyShutdown).not.toHaveBeenCalled()
    expect(recordStop).toHaveBeenCalledWith(
      TARGET,
      lease.ptyId,
      expect.objectContaining({ attempts: 0 })
    )
    installLegacyRelayBridge(null)
  })

  it('leaves a reversible stop’s pane live, with no durable stop recorded', async () => {
    const recordStop = vi.fn()
    const deps = install(recordStop)
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    await expect(
      stopAndWaitPtyFromRuntimeController(deps, ptyId, { keepHistory: true })
    ).resolves.toBe(false)
    expect(deps.finishPtyShutdown).not.toHaveBeenCalled()
    expect(recordStop).not.toHaveBeenCalled()
    installLegacyRelayBridge(null)
  })

  it('keeps the stop request of a final stop the bridge still owes, so the pane reads closing', async () => {
    const runtime = { markPtyStopRequested: vi.fn(), clearPtyStopRequest: vi.fn() }
    const recordStop = vi.fn()
    const deps = install(recordStop, runtime)
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    await expect(
      stopAndWaitPtyFromRuntimeController(deps, ptyId, { deadlineMs: Date.now() + 1_000 })
    ).resolves.toBe(false)
    expect(recordStop).toHaveBeenCalled()
    expect(runtime.clearPtyStopRequest).not.toHaveBeenCalled()
    installLegacyRelayBridge(null)
  })

  it('takes back the stop request of a refused reversible stop, so the pane reads running', async () => {
    const runtime = { markPtyStopRequested: vi.fn(), clearPtyStopRequest: vi.fn() }
    const deps = install(vi.fn(), runtime)
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    await expect(
      stopAndWaitPtyFromRuntimeController(deps, ptyId, { keepHistory: true })
    ).resolves.toBe(false)
    expect(runtime.markPtyStopRequested).toHaveBeenCalledWith(ptyId)
    expect(runtime.clearPtyStopRequest).toHaveBeenCalledWith(ptyId)
    installLegacyRelayBridge(null)
  })
})

describe('a stop-and-wait whose provider startup fails', () => {
  it('takes back its stop request, so the terminal still reads running', async () => {
    const runtime = { markPtyStopRequested: vi.fn(), clearPtyStopRequest: vi.fn() }
    const deps = {
      runtime,
      store: null,
      getLocalPtyProviderStartupPromise: () => Promise.reject(new Error('daemon failed')),
      shutdownProviderAndDetectExit: vi.fn(),
      finishPtyShutdown: vi.fn()
    }
    await expect(
      stopAndWaitPtyFromRuntimeController(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup await throws before any other dep is read.
        deps as unknown as PtyRuntimeControllerDeps,
        'local-pty-1'
      )
    ).rejects.toThrow('daemon failed')
    expect(runtime.markPtyStopRequested).toHaveBeenCalledWith('local-pty-1')
    expect(runtime.clearPtyStopRequest).toHaveBeenCalledWith('local-pty-1')
  })
})

describe('a failed tab-close stop', () => {
  it('takes back its stop request, so the terminal still reads running', async () => {
    installLegacyRelayBridge({
      leases: () => [lease],
      retireLease: vi.fn(),
      recordStop: vi.fn(),
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const runtime = {
      markPtyStopRequested: vi.fn(),
      clearPtyStopRequest: vi.fn(),
      intentionalPtyStops: { mark: () => () => {} }
    }
    const deps = {
      runtime,
      store: { markSshRemotePtyLease: vi.fn() },
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit: vi.fn(),
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch reads only these deps.
      stopRendererOwnedPty(deps as unknown as PtyKillIpcDeps, { id: ptyId, keepHistory: true })
    ).rejects.toThrow('legacy_relay_bridged_pty_cannot_sleep')
    expect(runtime.clearPtyStopRequest).toHaveBeenCalledWith(ptyId)
    installLegacyRelayBridge(null)
  })
})
