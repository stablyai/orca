import { afterEach, expect, it, vi } from 'vitest'
import { recoverOrcadRuntimeTerminals } from './orcad-runtime-terminal-recovery'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { createOrcadDelegatedProviderBinding } from './orcad-delegated-pty-provider'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('./orcad-delegated-recovery-lifecycle', () => ({
  installOrcadDelegatedRecovery: vi.fn()
}))
vi.mock('./orcad-delegated-pty-provider', () => ({
  createOrcadDelegatedProviderBinding: vi.fn(() => vi.fn(() => vi.fn()))
}))
const lifetimes: OrcadRuntimeLifetime[] = []
afterEach(async () => {
  await Promise.all(lifetimes.splice(0).map((lifetime) => lifetime.stop()))
  vi.clearAllMocks()
})
function setup() {
  const lifetime = new OrcadRuntimeLifetime(vi.fn())
  lifetimes.push(lifetime)
  const runtime = {
    recoverPtyOwnershipTransferDestinations: vi.fn(),
    refreshRestoredOrchestrationAuthority: vi.fn(async () => {}),
    reconcileLegacyWorkerTerminals: vi.fn(async () => {}),
    getPtyOwnershipTransferDestinationRegistry: vi.fn(),
    installCapturedPtyDestinationLifecycle: vi.fn(() => vi.fn()),
    acceptDelegatedPtyExecutionState: vi.fn(() => true),
    assertPublishedDelegatedPtyReserved: vi.fn(),
    stopLegacyWorkerTerminalRecovery: vi.fn(async () => {})
  }
  const lifecycle = {
    settleInitialRecovery: vi.fn(async () => [] as (typeof identity)[])
  }
  vi.mocked(installOrcadDelegatedRecovery).mockReturnValue(lifecycle as never)
  const start = () => recoverOrcadRuntimeTerminals(runtime as never, lifetime, vi.fn() as never)
  const notify = () =>
    vi.mocked(installOrcadDelegatedRecovery).mock.calls[0][0].onExecutionState!(identity, {
      generation: 1,
      claimId: 'current'
    })
  return { runtime, lifecycle, lifetime, start, notify }
}

it('settles delegated startup before authority refresh and worker reconciliation', async () => {
  const f = setup()
  await f.start()
  expect(f.lifecycle.settleInitialRecovery.mock.invocationCallOrder[0]).toBeLessThan(
    f.runtime.refreshRestoredOrchestrationAuthority.mock.invocationCallOrder[0]
  )
  expect(f.runtime.reconcileLegacyWorkerTerminals).toHaveBeenCalledOnce()
})

it('refreshes after a liveness transition but not repeated inventory observations', async () => {
  const f = setup()
  await f.start()
  f.notify()
  await vi.waitFor(() => expect(f.runtime.reconcileLegacyWorkerTerminals).toHaveBeenCalledTimes(2))
  f.runtime.acceptDelegatedPtyExecutionState.mockReturnValue(false)
  f.notify()
  await Promise.resolve()
  expect(f.runtime.refreshRestoredOrchestrationAuthority).toHaveBeenCalledTimes(2)
})

it('refreshes only after the delegated provider binding succeeds', async () => {
  const f = setup()
  await f.start()
  const bind = vi.mocked(installOrcadDelegatedRecovery).mock.calls[0][0].bindConnection!
  bind(identity, {} as never)
  await vi.waitFor(() => expect(f.runtime.reconcileLegacyWorkerTerminals).toHaveBeenCalledTimes(2))
  const binding = vi.mocked(createOrcadDelegatedProviderBinding).mock.results[0].value
  binding.mockImplementationOnce(() => {
    throw new Error('binding refused')
  })
  expect(() => bind(identity, {} as never)).toThrow('binding refused')
  await Promise.resolve()
  expect(f.runtime.refreshRestoredOrchestrationAuthority).toHaveBeenCalledTimes(2)
})

it('does not start authority recovery after a failed delegated startup', async () => {
  const f = setup()
  f.lifecycle.settleInitialRecovery.mockRejectedValue(new Error('unverifiable'))
  await expect(f.start()).rejects.toThrow('unverifiable')
  expect(f.runtime.refreshRestoredOrchestrationAuthority).not.toHaveBeenCalled()
})

it('ignores teardown liveness notifications after the runtime lifetime stops', async () => {
  const f = setup()
  await f.start()
  await f.lifetime.stop()
  f.notify()
  await Promise.resolve()
  expect(f.runtime.refreshRestoredOrchestrationAuthority).toHaveBeenCalledOnce()
})

it('starts with an offline reserved source and still runs fenced worker reconciliation', async () => {
  const f = setup()
  f.lifecycle.settleInitialRecovery.mockResolvedValue([identity])
  f.runtime.refreshRestoredOrchestrationAuthority.mockRejectedValue(
    new Error('terminal_liveness_unavailable')
  )
  await f.start()
  expect(f.runtime.assertPublishedDelegatedPtyReserved).toHaveBeenCalledWith(identity)
  expect(f.runtime.assertPublishedDelegatedPtyReserved.mock.invocationCallOrder[0]).toBeLessThan(
    f.runtime.refreshRestoredOrchestrationAuthority.mock.invocationCallOrder[0]
  )
  expect(f.runtime.reconcileLegacyWorkerTerminals).toHaveBeenCalledOnce()
  f.runtime.refreshRestoredOrchestrationAuthority.mockResolvedValue()
  f.notify()
  await vi.waitFor(() => expect(f.runtime.reconcileLegacyWorkerTerminals).toHaveBeenCalledTimes(2))
})

it('does not serve degraded startup without an exact no-fallback reservation', async () => {
  const f = setup()
  f.lifecycle.settleInitialRecovery.mockResolvedValue([identity])
  f.runtime.assertPublishedDelegatedPtyReserved.mockImplementation(() => {
    throw new Error('reservation mismatch')
  })
  await expect(f.start()).rejects.toThrow('reservation mismatch')
  expect(f.runtime.reconcileLegacyWorkerTerminals).not.toHaveBeenCalled()
})

it('refuses readiness when delegated recovery cannot certify durable reservations', async () => {
  const f = setup()
  f.lifecycle.settleInitialRecovery.mockRejectedValue(new Error('disk full'))
  await expect(f.start()).rejects.toThrow('disk full')
  expect(f.runtime.refreshRestoredOrchestrationAuthority).not.toHaveBeenCalled()
  expect(f.runtime.reconcileLegacyWorkerTerminals).not.toHaveBeenCalled()
})

it.each(['terminal_liveness_unavailable', 'corrupt authority receipt'])(
  'keeps %s fatal without a safely restored offline source',
  async (message) => {
    const f = setup()
    f.runtime.refreshRestoredOrchestrationAuthority.mockRejectedValue(new Error(message))
    await expect(f.start()).rejects.toThrow(message)
    expect(f.runtime.reconcileLegacyWorkerTerminals).not.toHaveBeenCalled()
  }
)

it('keeps unrelated startup errors fatal even with a reserved offline source', async () => {
  const f = setup()
  f.lifecycle.settleInitialRecovery.mockResolvedValue([identity])
  f.runtime.refreshRestoredOrchestrationAuthority.mockRejectedValue(
    new Error('corrupt authority receipt')
  )
  await expect(f.start()).rejects.toThrow('corrupt authority receipt')
  expect(f.runtime.reconcileLegacyWorkerTerminals).not.toHaveBeenCalled()
})

it('revalidates reservations after unavailable inventory before allowing worker reconciliation', async () => {
  const f = setup()
  f.lifecycle.settleInitialRecovery.mockResolvedValue([identity])
  f.runtime.refreshRestoredOrchestrationAuthority.mockRejectedValue(
    new Error('terminal_liveness_unavailable')
  )
  f.runtime.assertPublishedDelegatedPtyReserved
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('reservation changed')
    })
  await expect(f.start()).rejects.toThrow('reservation changed')
  expect(f.runtime.reconcileLegacyWorkerTerminals).not.toHaveBeenCalled()
})
