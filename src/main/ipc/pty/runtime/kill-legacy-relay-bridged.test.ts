import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import { installLegacyRelayBridge } from '../../../ssh/legacy-relay/legacy-relay-bridge-registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { killPtyFromRuntimeController } from './kill'

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
