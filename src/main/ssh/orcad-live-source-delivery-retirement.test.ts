import { beforeEach, expect, it, vi } from 'vitest'
import { retireOrcadLiveSourceDeliveries } from './orcad-live-source-delivery-retirement'
const f = vi.hoisted(() => ({
  readiness: vi.fn(),
  group: vi.fn(),
  capture: vi.fn(),
  source: vi.fn(),
  delivery: vi.fn(),
  retire: vi.fn(),
  cancel: vi.fn(),
  receipt: vi.fn(),
  persist: vi.fn(),
  read: vi.fn()
}))
vi.mock('./orcad-live-runtime-restart-readiness', () => ({
  withOrcadLiveRuntimeRestartReadiness: f.readiness
}))
vi.mock('./orcad-live-catalog-admissions', () => ({ groupOrcadLiveCatalogAdmissions: f.group }))
vi.mock('./orcad-live-retirement-capture', () => ({ bindOrcadLiveRetirementCapture: f.capture }))
vi.mock('./orcad-outgoing-source-binding', () => ({ bindReleasedOutgoingOrcadIncumbent: f.source }))
vi.mock('./orcad-live-source-retirement-delivery', () => ({
  createOrcadLiveSourceRetirementDelivery: f.delivery,
  reconstructOrcadLiveSourceRetirementDelivery: f.delivery
}))
vi.mock('./orcad-captured-source-retirement-client', () => ({
  retireRemoteOrcadCapturedSourceDelivery: f.retire
}))
vi.mock('../providers/ssh-pty-source-delivery-state', () => ({
  confirmSettledSourceDeliveryCancellation: f.cancel
}))
vi.mock('./orcad-live-source-cancellation-receipt', () => ({
  createOrcadLiveSourceCancellationReceipt: f.receipt,
  OrcadLiveSourceCancellationReceiptStore: class {
    persist = f.persist
    read = f.read
  }
}))
beforeEach(() => vi.resetAllMocks())

function fixture() {
  const events: string[] = []
  const saved = new Map<string, unknown>()
  f.read.mockImplementation((identity) => saved.get(identity.terminalId) ?? null)
  const identities = ['one', 'two'].map((terminalId) => ({ terminalId, bridgeId: terminalId }))
  const assertCurrent = vi.fn()
  const request = vi.fn()
  const boundAuthority = vi.fn()
  const record = {
    sha256: 'a'.repeat(64),
    release: {
      cutover: {
        destinationEnvironmentId: 'environment',
        manifest: { source: { sshTargetId: 'host' } },
        terminalPublications: identities.map((identity) => ({
          identity,
          publicationReceipt: { identity }
        }))
      }
    }
  }
  const context = {
    record,
    pairingCode: 'paired',
    assertCurrent,
    outputEvidence: { settlements: identities.map(({ terminalId }) => ({ id: terminalId })) }
  }
  f.readiness.mockImplementation(async (_options, operation) => operation(context))
  f.group.mockReturnValue([{ bindings: identities.map((identity) => ({ identity })) }])
  f.capture.mockImplementation(({ identity }) => {
    events.push(`prepare:${identity.terminalId}`)
    return { capture: { selection: { boundary: {} } }, assertCurrent }
  })
  f.source.mockReturnValue({ providerGeneration: 901, request, assertIncumbent: boundAuthority })
  f.delivery.mockReturnValue({ sentEndSu: 10 })
  f.retire.mockImplementation(async ({ request }) => {
    events.push(`retire:${request.identity.terminalId}`)
    return {
      identity: request.identity,
      sourceDeliveryRetirement: { delivery: request.expectedDelivery }
    }
  })
  f.cancel.mockImplementation(async () => {
    events.push('cancel')
    return { cancellation: { canceled: true } }
  })
  f.receipt.mockImplementation(({ retirement, cancellation }) => ({
    identity: retirement.identity,
    retirement,
    cancellation
  }))
  f.persist.mockImplementation((receipt) => {
    events.push('persist')
    saved.set(receipt.identity.terminalId, receipt)
    return receipt
  })
  const run = (recoveryOnly = false) =>
    retireOrcadLiveSourceDeliveries({
      ...(recoveryOnly ? { recoveryOnly: true } : {}),
      profileDirectory: '/test-profile',
      migrationId: 'migration',
      signal: new AbortController().signal,
      store: {} as never,
      runtime: {} as never
    })
  return { run, events, boundAuthority, request, saved }
}

it.each([true, false])(
  'requires host confirmation for provider-free recovery: %s',
  async (confirmed) => {
    const s = fixture()
    f.source.mockImplementation(() => {
      throw new Error('old provider unavailable')
    })
    const retire = f.retire.getMockImplementation()!
    f.retire.mockImplementation(async (options) => ({
      ...(await retire(options)),
      ...(confirmed ? { sourceCancellation: { canceled: true } } : {})
    }))
    const result = s.run(true)
    await (confirmed
      ? expect(result).resolves.toMatchObject({ phase: 'source-deliveries-retired' })
      : expect(result).rejects.toThrow('cancellation_required'))
    expect(f.source).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.retire).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ recoveryOnly: true }) })
    )
    expect(f.persist).toHaveBeenCalledTimes(confirmed ? 2 : 0)
  }
)

it('leaves an unattempted member pending during recovery without creating its host retirement', async () => {
  const s = fixture()
  const retire = f.retire.getMockImplementation()!
  f.retire.mockImplementation(async (options) => {
    expect(options.request.recoveryOnly).toBe(true)
    if (options.request.identity.terminalId === 'two') {
      throw new Error('recovery_journal_required')
    }
    return { ...(await retire(options)), sourceCancellation: { canceled: true } }
  })
  await expect(s.run(true)).rejects.toThrow('recovery_journal_required')
  expect(s.saved.size).toBe(1)
  expect(s.saved.has('one')).toBe(true)
  f.retire.mockClear()
  await expect(s.run(true)).rejects.toThrow('recovery_journal_required')
  expect(f.retire).toHaveBeenCalledOnce()
  expect(f.retire.mock.calls[0][0].request.identity.terminalId).toBe('two')
  expect(f.source).not.toHaveBeenCalled()
  expect(f.cancel).not.toHaveBeenCalled()
})

it('prepares the entire cohort then orders retirement, cancellation and durable receipt', async () => {
  const s = fixture()
  expect(await s.run()).toMatchObject({
    phase: 'source-deliveries-retired',
    receipts: [{ identity: { terminalId: 'one' } }, { identity: { terminalId: 'two' } }]
  })
  expect(s.events).toEqual([
    'prepare:one',
    'prepare:two',
    'retire:one',
    'cancel',
    'persist',
    'retire:two',
    'cancel',
    'persist'
  ])
  expect(f.cancel.mock.calls[0][0].request).toBe(s.request)
  expect(f.retire.mock.calls[0][0].pairingCode).toBe('paired')
})

it('refuses an unavailable cohort member before any host mutation', async () => {
  const s = fixture()
  f.source
    .mockImplementationOnce(() => ({ providerGeneration: 901, assertIncumbent: vi.fn() }))
    .mockImplementationOnce(() => {
      throw new Error('source unavailable')
    })
  await expect(s.run()).rejects.toThrow('source unavailable')
  expect(f.retire).not.toHaveBeenCalled()
  expect(f.cancel).not.toHaveBeenCalled()
})

it.each(['retire', 'cancel', 'persist'] as const)(
  'stops after %s failure without claiming completion',
  async (stage) => {
    const s = fixture()
    f[stage].mockImplementationOnce(() => {
      throw new Error('uncertain')
    })
    await expect(s.run()).rejects.toThrow('uncertain')
    expect(f.retire).toHaveBeenCalledOnce()
    if (stage === 'retire') {
      expect(f.cancel).not.toHaveBeenCalled()
    }
    if (stage !== 'persist') {
      expect(f.persist).not.toHaveBeenCalled()
    }
  }
)

it('does not cancel source after authority changes during remote retirement', async () => {
  const s = fixture()
  f.retire.mockImplementationOnce(async () => {
    s.boundAuthority.mockImplementation(() => {
      throw new Error('authority lost')
    })
    return { sourceDeliveryRetirement: { delivery: {} } }
  })
  await expect(s.run()).rejects.toThrow('authority lost')
  expect(f.cancel).not.toHaveBeenCalled()
  expect(f.persist).not.toHaveBeenCalled()
})

it('resumes a partially persisted cohort without reconnecting or recancelling its completed member', async () => {
  const s = fixture()
  f.retire
    .mockImplementationOnce(async ({ request }) => ({
      identity: request.identity,
      sourceDeliveryRetirement: { delivery: request.expectedDelivery }
    }))
    .mockRejectedValueOnce(new Error('second source unavailable'))
  await expect(s.run()).rejects.toThrow('second source unavailable')
  expect(s.saved.has('one')).toBe(true)
  f.capture.mockClear()
  f.source.mockClear()
  f.retire.mockClear()
  f.cancel.mockClear()
  await expect(s.run()).resolves.toMatchObject({ phase: 'source-deliveries-retired' })
  expect(f.capture).toHaveBeenCalledOnce()
  expect(f.capture.mock.calls[0][0].identity.terminalId).toBe('two')
  expect(f.source).toHaveBeenCalledOnce()
  expect(f.retire).toHaveBeenCalledOnce()
  expect(f.cancel).toHaveBeenCalledOnce()
})

it('reflushes completed receipts without requiring any source provider', async () => {
  const s = fixture()
  await s.run()
  f.source.mockImplementation(() => {
    throw new Error('old provider gone')
  })
  f.source.mockClear()
  f.retire.mockClear()
  f.cancel.mockClear()
  f.persist.mockClear()
  await expect(s.run()).resolves.toMatchObject({ phase: 'source-deliveries-retired' })
  expect(f.source).not.toHaveBeenCalled()
  expect(f.retire).not.toHaveBeenCalled()
  expect(f.cancel).not.toHaveBeenCalled()
  expect(f.persist).toHaveBeenCalledTimes(2)
})

it('rejects conflicting saved receipt before new host mutation', async () => {
  const s = fixture()
  await s.run()
  const first = s.saved.get('one') as Record<string, unknown>
  s.saved.set('one', { ...first, migrationId: 'foreign' })
  f.retire.mockClear()
  await expect(s.run()).rejects.toThrow('receipt_conflict')
  expect(f.retire).not.toHaveBeenCalled()
})

it('does not acknowledge completed receipts when their durable reflush fails', async () => {
  const s = fixture()
  await s.run()
  f.persist.mockImplementationOnce(() => {
    throw new Error('reflush uncertain')
  })
  f.retire.mockClear()
  f.cancel.mockClear()
  await expect(s.run()).rejects.toThrow('reflush uncertain')
  expect(f.retire).not.toHaveBeenCalled()
  expect(f.cancel).not.toHaveBeenCalled()
})

it('refuses a changed completed receipt while another terminal is retiring', async () => {
  const s = fixture()
  f.retire
    .mockImplementationOnce(async ({ request }) => ({
      identity: request.identity,
      sourceDeliveryRetirement: { delivery: request.expectedDelivery }
    }))
    .mockImplementationOnce(async ({ request }) => {
      s.saved.delete('one')
      return {
        identity: request.identity,
        sourceDeliveryRetirement: { delivery: request.expectedDelivery }
      }
    })
  await expect(s.run()).rejects.toThrow('receipt_changed')
  expect(f.cancel).toHaveBeenCalledOnce()
  expect(f.persist).toHaveBeenCalledOnce()
})
