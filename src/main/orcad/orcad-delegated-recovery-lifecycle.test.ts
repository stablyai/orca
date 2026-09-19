import { afterEach, expect, it, vi } from 'vitest'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('./orcad-delegated-connection', () => ({ connectOrcadDelegatedTransfer: vi.fn() }))
type Options = Parameters<typeof installOrcadDelegatedRecovery>[0]
type Connection = Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
const lifetimes: OrcadRuntimeLifetime[] = []
afterEach(async () => {
  await Promise.all(lifetimes.splice(0).map((lifetime) => lifetime.stop()))
  vi.mocked(connectOrcadDelegatedTransfer).mockReset()
})
function setup() {
  const release = vi.fn()
  const lifetime = new OrcadRuntimeLifetime(release)
  lifetimes.push(lifetime)
  const discover = vi.fn(() => [
    { identity, store: {}, outbox: { loadRetirement: () => null } as object, adapter: {} }
  ])
  const published = vi.fn(() => ({ identity, store: {}, outbox: {}, adapter: {} }))
  const prepareCaptured = vi.fn(async () => ({ snapshot: { identity } }))
  const options: Options = {
    enabled: true,
    registry: {
      recoverPersistedDelegatedDestinations: discover,
      prepareCapturedDelegated: prepareCaptured,
      assertDestinationAdmissionOpen: vi.fn(),
      get: () => null,
      getPublishedDelegatedDestination: published
    } as unknown as Options['registry'],
    lifetime,
    prepareModelFrame: vi.fn(async () => {}),
    initializeModel: vi.fn(async () => {}),
    onError: vi.fn()
  }
  return { options, discover, published, prepareCaptured, release, lifetime }
}

it('does not discover or contact source hosts while the migration gate is disabled', async () => {
  const fixture = setup()
  expect(installOrcadDelegatedRecovery({ ...fixture.options, enabled: false })).toBeNull()
  expect(fixture.discover).not.toHaveBeenCalled()
  await fixture.lifetime.stop()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
  expect(fixture.release).toHaveBeenCalledOnce()
})

it('does not construct recovery without a destination registry', () => {
  expect(installOrcadDelegatedRecovery({ ...setup().options, registry: null })).toBeNull()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('keeps initial recovery pending until source commit reconciliation, with lifetime cancellation', async () => {
  const fixture = setup()
  const waitForCommitReconciled = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    waitForCommitReconciled,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  const settled = vi.fn()
  const pending = lifecycle.settleInitialRecovery().then(settled)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(waitForCommitReconciled).toHaveBeenCalledOnce())
  expect(settled).not.toHaveBeenCalled()
  await fixture.lifetime.stop()
  await rejected
  expect(waitForCommitReconciled.mock.calls[0][0].aborted).toBe(true)
})

it('does not acknowledge reconciliation if its source connection becomes inactive while waiting', async () => {
  const fixture = setup()
  let active = true
  const waitForCommitReconciled = vi.fn(async () => {
    active = false
  })
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => active,
    waitForCommitReconciled,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await expect(lifecycle.settleInitialRecovery()).rejects.toThrow('authority_unverifiable')
})

it('exposes a caller-cancellable commit barrier without treating publication as live authority', async () => {
  const fixture = setup()
  const waitForCommitReconciled = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted()
  })
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    waitForCommitReconciled,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery(fixture.options)!
  await lifecycle.supervisor.settlePendingConnections()
  await lifecycle.waitForDestinationCommit(identity, new AbortController().signal)
  expect(waitForCommitReconciled).toHaveBeenCalledOnce()
  const controller = new AbortController()
  controller.abort(new Error('caller stopped'))
  await expect(lifecycle.waitForDestinationCommit(identity, controller.signal)).rejects.toThrow(
    'caller stopped'
  )
  expect(waitForCommitReconciled).toHaveBeenCalledOnce()
})

it('passes durable retirement recovery into discovery before any connection starts', () => {
  const fixture = setup()
  fixture.discover.mockReturnValue([])
  const recoverRetirement = vi.fn()
  installOrcadDelegatedRecovery({ ...fixture.options, recoverRetirement })
  expect(fixture.discover).toHaveBeenCalledExactlyOnceWith(recoverRetirement)
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('retires supervision only after the runtime durably applies an accepted exit', async () => {
  const fixture = setup()
  let applied = false
  let exiting = false
  const onExit = vi.fn()
  fixture.discover.mockReturnValue([
    {
      identity,
      adapter: {},
      store: {},
      outbox: {
        loadRetirement: () => (exiting ? { phase: applied ? 'applied' : 'prepared' } : null)
      }
    }
  ])
  const dispose = vi.fn(async () => {})
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose,
    isActive: () => true,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery({
    ...fixture.options,
    onExit,
    recoverRetirement: vi.fn()
  })!
  await Promise.resolve()
  await Promise.resolve()
  const accept = vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].onExit!
  const retire = vi.spyOn(lifecycle.supervisor, 'retire')
  exiting = true
  expect(() => accept({ identity } as never)).toThrow('retirement_incomplete')
  expect(retire).not.toHaveBeenCalled()
  applied = true
  accept({ identity } as never)
  expect(onExit).toHaveBeenCalledTimes(2)
  expect(retire).toHaveBeenCalledExactlyOnceWith(identity)
  expect(dispose).not.toHaveBeenCalled()
  await retire.mock.results[0].value
  expect(dispose).toHaveBeenCalledOnce()
})

it('forwards the runtime exit consumer to discovered connections', async () => {
  const fixture = setup()
  const onExit = vi.fn()
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  installOrcadDelegatedRecovery({ ...fixture.options, onExit })
  await Promise.resolve()
  expect(vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].onExit).toBe(onExit)
})

it('selects runtime model ingestion with immutable identity/frame and shutdown fencing', async () => {
  const fixture = setup()
  const discovered = { identity: { ...identity }, store: {}, outbox: {}, adapter: {} }
  fixture.discover.mockReturnValue([discovered])
  const prepareModelFrame = vi.fn<Options['prepareModelFrame']>(async () => {})
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  installOrcadDelegatedRecovery({ ...fixture.options, prepareModelFrame })
  await Promise.resolve()
  const prepare = vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].prepareModelFrame!
  discovered.identity.terminalId = 'mutated'
  const frame = { seq: 1, data: 'retained output' }
  await prepare(frame)
  expect(prepareModelFrame).toHaveBeenCalledWith(identity, frame, expect.any(AbortSignal))
  const [capturedIdentity, capturedFrame, signal] = prepareModelFrame.mock.calls[0]
  expect(Object.isFrozen(capturedIdentity)).toBe(true)
  expect(Object.isFrozen(capturedFrame)).toBe(true)
  expect(capturedFrame).not.toBe(frame)
  expect(signal.aborted).toBe(false)
  await fixture.lifetime.stop()
  expect(signal.aborted).toBe(true)
  expect(() => prepare(frame)).toThrow()
  expect(prepareModelFrame).toHaveBeenCalledOnce()
})

it('coalesces model initialization and does not restore again on reconnect', async () => {
  const fixture = setup()
  let finish!: () => void
  const initializeModel = vi.fn<Options['initializeModel']>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  installOrcadDelegatedRecovery({ ...fixture.options, initializeModel })
  await Promise.resolve()
  const initialize = vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].initializeModel!
  const signal = new AbortController().signal
  const first = initialize(signal)
  const second = initialize(signal)
  await Promise.resolve()
  expect(initializeModel).toHaveBeenCalledOnce()
  finish()
  await Promise.all([first, second])
  await initialize(new AbortController().signal)
  expect(initializeModel).toHaveBeenCalledOnce()
})

it('registers cleanup before discovery so a corrupt record unwinds without source contact', async () => {
  const fixture = setup()
  fixture.discover.mockImplementation(() => {
    throw new Error('corrupt destination')
  })
  expect(() => installOrcadDelegatedRecovery(fixture.options)).toThrow('corrupt destination')
  await fixture.lifetime.stop()
  expect(fixture.release).toHaveBeenCalledOnce()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('holds the runtime lock until late connection startup is fenced and settled', async () => {
  const fixture = setup()
  let finish!: (connection: Connection) => void
  vi.mocked(connectOrcadDelegatedTransfer).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const supervisor = installOrcadDelegatedRecovery(fixture.options)
  expect(supervisor).not.toBeNull()
  await Promise.resolve()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  const stopping = fixture.lifetime.stop()
  await Promise.resolve()
  const signal = vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0].signal
  expect(signal.aborted).toBe(true)
  expect(fixture.release).not.toHaveBeenCalled()
  const dispose = vi.fn()
  finish({ dispose, isActive: () => true } as unknown as Connection)
  await stopping
  expect(dispose).toHaveBeenCalledOnce()
  expect(fixture.release).toHaveBeenCalledOnce()
})

it('tracks a newly published destination without rediscovering or resetting startup adapters', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  const destination = { identity, store: {}, outbox: {}, adapter: {} }
  f.published.mockReturnValue(destination)
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
  lifecycle.trackPublishedDestination(identity)
  lifecycle.trackPublishedDestination(identity)
  await Promise.resolve()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledWith(expect.objectContaining(destination))
  expect(f.discover).toHaveBeenCalledOnce()
  const options = vi.mocked(connectOrcadDelegatedTransfer).mock.calls[0][0]
  await options.initializeModel!(new AbortController().signal)
  await options.prepareModelFrame!({ seq: 2, data: 'new' })
  expect(f.options.initializeModel).toHaveBeenCalledOnce()
  expect(f.options.prepareModelFrame).toHaveBeenCalledOnce()
})

it('holds catalog publication acknowledgment until the source commit is reconciled', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  let reconcile!: () => void
  const waitForCommitReconciled = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        reconcile = resolve
      })
  )
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    waitForCommitReconciled,
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  const acknowledged = vi.fn()
  const pending = lifecycle
    .prepareCapturedDestination({
      identity,
      source: {},
      model: {},
      catalogAdmission: {},
      signal: new AbortController().signal
    })
    .then(acknowledged)
  await vi.waitFor(() => expect(waitForCommitReconciled).toHaveBeenCalledOnce())
  expect(f.prepareCaptured).toHaveBeenCalledOnce()
  expect(acknowledged).not.toHaveBeenCalled()
  reconcile()
  await pending
  expect(acknowledged).toHaveBeenCalledOnce()
})

it('retains published catalog state but refuses acknowledgment when reconciliation loses contact', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  vi.mocked(connectOrcadDelegatedTransfer).mockResolvedValue({
    dispose: vi.fn(),
    isActive: () => true,
    waitForCommitReconciled: vi.fn(async () => {
      throw new Error('source unverifiable')
    }),
    multiplexer: { onDispose: () => () => {} }
  } as unknown as Connection)
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  await expect(
    lifecycle.prepareCapturedDestination({
      identity,
      source: {},
      model: {},
      catalogAdmission: {},
      signal: new AbortController().signal
    })
  ).rejects.toThrow('source unverifiable')
  expect(f.prepareCaptured).toHaveBeenCalledOnce()
  expect(f.published).toHaveBeenCalledOnce()
})

it('coalesces dynamic tracking with startup recovery and rejects changed adapter instances', async () => {
  const f = setup()
  const destination = { identity, store: {}, outbox: {}, adapter: {} }
  f.discover.mockReturnValue([destination])
  f.published.mockReturnValue(destination)
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  lifecycle.trackPublishedDestination(identity)
  f.published.mockReturnValue({ ...destination, adapter: {} })
  expect(() => lifecycle.trackPublishedDestination(identity)).toThrow('destination_conflict')
  await Promise.resolve()
  expect(connectOrcadDelegatedTransfer).toHaveBeenCalledOnce()
})

it('does not contact a source when publication lookup fails', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  f.published.mockImplementation(() => {
    throw new Error('not published')
  })
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  expect(() => lifecycle.trackPublishedDestination(identity)).toThrow('not published')
  await Promise.resolve()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('fences dynamic tracking before registry access when the runtime stops', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  await f.lifetime.stop()
  expect(() => lifecycle.trackPublishedDestination(identity)).toThrow()
  expect(f.published).not.toHaveBeenCalled()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('does not acknowledge a duplicate join after the supervisor was explicitly stopped', async () => {
  const f = setup()
  const destination = { identity, store: {}, outbox: {}, adapter: {} }
  f.discover.mockReturnValue([destination])
  f.published.mockReturnValue(destination)
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  await lifecycle.supervisor.stop()
  expect(() => lifecycle.trackPublishedDestination(identity)).toThrow('supervisor_stopped')
})

it.each(['request', 'shutdown', 'supervisor'] as const)(
  'does not start captured preparation after %s cancellation',
  async (cause) => {
    const f = setup()
    f.discover.mockReturnValue([])
    const lifecycle = installOrcadDelegatedRecovery(f.options)!
    const controller = new AbortController()
    if (cause === 'request') {
      controller.abort()
    } else if (cause === 'supervisor') {
      await lifecycle.supervisor.stop()
    } else {
      await f.lifetime.stop()
    }
    await expect(
      lifecycle.prepareCapturedDestination({
        identity,
        source: {},
        model: {},
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(f.prepareCaptured).not.toHaveBeenCalled()
    expect(f.published).not.toHaveBeenCalled()
  }
)

it.each(['request', 'shutdown', 'supervisor'] as const)(
  'does not enroll a published capture when %s interrupts preparation',
  async (cause) => {
    const f = setup()
    f.discover.mockReturnValue([])
    const lifecycle = installOrcadDelegatedRecovery(f.options)!
    const controller = new AbortController()
    f.prepareCaptured.mockImplementationOnce(async (...args: unknown[]) => {
      const { signal } = args[0] as { signal: AbortSignal }
      expect(signal.aborted).toBe(false)
      if (cause === 'request') {
        controller.abort()
      } else if (cause === 'supervisor') {
        await lifecycle.supervisor.stop()
      } else {
        void f.lifetime.stop()
      }
      expect(signal.aborted).toBe(true)
      return { snapshot: { identity } }
    })
    await expect(
      lifecycle.prepareCapturedDestination({
        identity,
        source: {},
        model: {},
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(f.prepareCaptured).toHaveBeenCalledOnce()
    expect(f.published).not.toHaveBeenCalled()
    expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
  }
)

it('holds the runtime instance lock until canceled capture preparation settles', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  let finish!: () => void
  let preparationSignal!: AbortSignal
  f.prepareCaptured.mockImplementationOnce(async (...args: unknown[]) => {
    preparationSignal = (args[0] as { signal: AbortSignal }).signal
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { snapshot: { identity } }
  })
  const pending = lifecycle.prepareCapturedDestination({
    identity,
    source: {},
    model: {},
    signal: new AbortController().signal
  })
  const rejected = expect(pending).rejects.toThrow()
  await Promise.resolve()
  const stopping = f.lifetime.stop()
  await Promise.resolve()
  expect(preparationSignal.aborted).toBe(true)
  expect(f.release).not.toHaveBeenCalled()
  finish()
  await rejected
  await stopping
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.published).not.toHaveBeenCalled()
  expect(connectOrcadDelegatedTransfer).not.toHaveBeenCalled()
})

it('refuses overlapping capture requests until the first attempt has fully settled', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  const request = { identity, source: {}, model: {}, signal: new AbortController().signal }
  let fail!: (error: Error) => void
  f.prepareCaptured.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  const first = lifecycle.prepareCapturedDestination(request)
  const failed = expect(first).rejects.toThrow('storage failed')
  await Promise.resolve()
  await expect(lifecycle.prepareCapturedDestination(request)).rejects.toThrow('preparation_pending')
  await expect(
    lifecycle.prepareCapturedDestination({
      ...request,
      identity: { ...identity, ownerLease: 'different-owner' }
    })
  ).rejects.toThrow('preparation_pending')
  expect(f.prepareCaptured).toHaveBeenCalledOnce()
  expect(f.published).not.toHaveBeenCalled()
  fail(new Error('storage failed'))
  await failed
  await lifecycle.prepareCapturedDestination(request)
  expect(f.prepareCaptured).toHaveBeenCalledTimes(2)
  expect(f.published).toHaveBeenCalledOnce()
})

it('does not serialize unrelated bridges behind a pending capture', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  let finish!: () => void
  f.prepareCaptured.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { snapshot: { identity } }
  })
  const request = { identity, source: {}, model: {}, signal: new AbortController().signal }
  const first = lifecycle.prepareCapturedDestination(request)
  await Promise.resolve()
  f.prepareCaptured.mockRejectedValueOnce(new Error('second bridge reached preparation'))
  await expect(
    lifecycle.prepareCapturedDestination({
      ...request,
      identity: { ...identity, bridgeId: 'other-bridge' }
    })
  ).rejects.toThrow('second bridge reached preparation')
  expect(f.prepareCaptured).toHaveBeenCalledTimes(2)
  finish()
  await first
})

it('keeps the admitted transfer identity when its caller mutates the request before preparation', async () => {
  const f = setup()
  f.discover.mockReturnValue([])
  const lifecycle = installOrcadDelegatedRecovery(f.options)!
  const mutableIdentity = { ...identity }
  const pending = lifecycle.prepareCapturedDestination({
    identity: mutableIdentity,
    source: {},
    model: {},
    signal: new AbortController().signal
  })
  mutableIdentity.bridgeId = 'changed-after-admission'
  await pending
  expect(f.prepareCaptured).toHaveBeenCalledWith(expect.objectContaining({ identity }))
})
