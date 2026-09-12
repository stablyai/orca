import { afterEach, expect, it, vi } from 'vitest'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { OrcadLocalRelayUnavailableError } from './orcad-local-relay-unavailable'

vi.mock('./orcad-delegated-connection', () => ({ connectOrcadDelegatedTransfer: vi.fn() }))
type Options = Parameters<typeof installOrcadDelegatedRecovery>[0]
const lifetimes: OrcadRuntimeLifetime[] = []
afterEach(async () => {
  await Promise.all(lifetimes.splice(0).map((lifetime) => lifetime.stop()))
  vi.mocked(connectOrcadDelegatedTransfer).mockReset()
})

function setup() {
  const lifetime = new OrcadRuntimeLifetime(vi.fn())
  lifetimes.push(lifetime)
  const loadRetirement = vi.fn<() => { phase: string } | null>(() => null)
  const initializeModel = vi.fn<Options['initializeModel']>(async () => {})
  const options: Options = {
    enabled: true,
    registry: {
      recoverPersistedDelegatedDestinations: () => [
        { identity, store: {}, outbox: { loadRetirement }, adapter: {} }
      ]
    } as unknown as Options['registry'],
    lifetime,
    initializeModel,
    prepareModelFrame: vi.fn(async () => {}),
    onError: vi.fn()
  }
  return { options, lifetime, loadRetirement, initializeModel }
}

it('refuses initial readiness when the source cannot be contacted', async () => {
  const fixture = setup()
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(new Error('source offline'))
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery()).rejects.toThrow(
    'orcad_delegated_pty_authority_unverifiable'
  )
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
})

it('preserves model restoration failure instead of classifying it as a source outage', async () => {
  const fixture = setup()
  const corruption = new Error('captured model corrupt')
  fixture.initializeModel.mockRejectedValue(corruption)
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async (options) => {
    await options.initializeModel!(options.signal)
    throw new Error('source offline')
  })
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery()).rejects.toBe(corruption)
  expect(fixture.initializeModel).toHaveBeenCalledOnce()
})

it('clears a prior initialization error only after a successful explicit retry', async () => {
  const fixture = setup()
  const corruption = new Error('captured model corrupt')
  fixture.initializeModel.mockRejectedValueOnce(corruption)
  const waitForCommitReconciled = vi.fn(async () => {})
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async (options) => {
    await options.initializeModel!(options.signal)
    return {
      dispose: vi.fn(),
      isActive: () => true,
      multiplexer: { onDispose: () => () => {} },
      waitForCommitReconciled
    } as unknown as Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
  })
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery()).rejects.toBe(corruption)
  lifecycle.supervisor.retry(identity)
  await expect(lifecycle.settleInitialRecovery()).resolves.toEqual([])
  expect(fixture.initializeModel).toHaveBeenCalledTimes(2)
  expect(waitForCommitReconciled).toHaveBeenCalledOnce()
})

it('permits an applied durable retirement without a source connection', async () => {
  const fixture = setup()
  fixture.loadRetirement.mockReturnValue({ phase: 'applied' })
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(new Error('source offline'))
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery()).resolves.toEqual([])
})

it('does not treat a prepared retirement as applied evidence', async () => {
  const fixture = setup()
  fixture.loadRetirement.mockReturnValue({ phase: 'prepared' })
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(new Error('source offline'))
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery()).rejects.toThrow(
    'orcad_delegated_pty_authority_unverifiable'
  )
})

it('refuses readiness after lifetime cancellation even with no persisted destinations', async () => {
  const fixture = setup()
  fixture.options.registry = {
    recoverPersistedDelegatedDestinations: () => []
  } as unknown as Options['registry']
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await fixture.lifetime.stop()
  await expect(lifecycle.settleInitialRecovery()).rejects.toThrow()
})

it('returns an offline source only after its model has been restored successfully', async () => {
  const fixture = setup()
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async (options) => {
    await options.initializeModel!(options.signal)
    throw new OrcadLocalRelayUnavailableError(new Error('connection refused'))
  })
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery(true)).resolves.toEqual([identity])
  expect(fixture.initializeModel).toHaveBeenCalledOnce()
})

it('does not permit degraded startup when model initialization never completed', async () => {
  const fixture = setup()
  const error = new OrcadLocalRelayUnavailableError(new Error('connection refused'))
  vi.mocked(connectOrcadDelegatedTransfer).mockRejectedValue(error)
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery(true)).rejects.toBe(error)
})

it('keeps protocol and evidence failures fatal after successful model initialization', async () => {
  const fixture = setup()
  const error = new Error('claim rejected')
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(async (options) => {
    await options.initializeModel!(options.signal)
    throw error
  })
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery(true)).rejects.toBe(error)
})
