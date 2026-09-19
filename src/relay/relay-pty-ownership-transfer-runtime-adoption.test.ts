import { describe, expect, it, vi } from 'vitest'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
} from '../shared/pty-ownership-transfer-wire'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type {
  RelayPtyOwnershipTransferDurableRecord,
  RelayPtyOwnershipTransferStore
} from './relay-pty-ownership-transfer-adapter-contract'
import { adoptDormantRelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-runtime-adoption'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD } from '../shared/pty-ownership-transfer-source-retirement'
import { PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD } from '../shared/pty-ownership-transfer-successor-retirement'

const source = {
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1
}

const identity = {
  version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  bridgeId: 'bridge-1',
  ...source,
  destinationRuntimeId: 'runtime-1'
}

function createAdoption(
  options: {
    outputAvailable?: boolean
    store?: RelayPtyOwnershipTransferStore
    capture?: boolean
    retirement?: boolean
    retirementFactory?: boolean
    successor?: boolean
  } = {}
) {
  const ptyHandler = {
    ...(options.successor
      ? {
          beginOwnershipTransferCaptureIngress: vi.fn(() => {
            throw new Error('unexpected ingress')
          })
        }
      : {}),
    inspectOwnershipTransferCwd: vi.fn(async () => null),
    inspectOwnershipTransferProcess: vi.fn(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false
    })),
    setOwnershipTransferOutputObserver: vi.fn(),
    hasPendingOwnershipTransferOutput: vi.fn(() => false),
    resolveOwnershipTransferTerminal: vi.fn(() => ({
      terminalId: source.terminalId,
      incarnationId: source.incarnationId
    })),
    setOwnershipTransferInputFenced: vi.fn(),
    writeOwnershipTransferInput: vi.fn(() => true),
    applyOwnershipTransferControl: vi.fn(async () => 'applied' as const)
  }
  const sourcePublication = {
    ...(options.successor
      ? {
          prepareCoveredOwnershipTransferRetirement: vi.fn(() => {
            throw new Error('unexpected covered retirement')
          })
        }
      : {}),
    ...(options.retirementFactory
      ? {
          prepareOwnershipTransferRetirement: vi.fn(() => {
            throw new Error('preparation not requested')
          })
        }
      : {}),
    accepts: vi.fn(() => options.outputAvailable ?? true),
    ownershipTransfer: {
      ...(options.successor ? { inspectSuccessorRetainedDelivery: vi.fn(() => null) } : {}),
      resolve: vi.fn(() => source),
      authorizes: vi.fn(
        (_id: string, _lease: string, _generation: number, clientId: number) => clientId === 1
      ),
      authorizesResumedTransfer: vi.fn(
        (_lease: string, _generation: number, clientId: number) => clientId === 2
      ),
      authorizesResumedTransferAtGeneration: vi.fn(
        (_lease: string, generation: number, clientId: number) => clientId === 2 && generation === 2
      )
    }
  }
  const adapter = adoptDormantRelayPtyOwnershipTransferAdapter(
    ptyHandler,
    sourcePublication,
    undefined,
    options.store,
    options.capture,
    options.retirement
  )
  return { adapter, ptyHandler, sourcePublication }
}

function memoryStore(): RelayPtyOwnershipTransferStore {
  const records = new Map<string, RelayPtyOwnershipTransferDurableRecord>()
  return {
    loadAll: () => [...records.values()].map((record) => structuredClone(record)),
    save: (record) => records.set(record.identity.bridgeId, structuredClone(record)),
    remove: (bridgeId) => void records.delete(bridgeId)
  }
}

it.each([false, true])(
  'adopts successor retirement only with explicit retirement opt-in (%s)',
  async (retirement) => {
    const f = createAdoption({
      store: memoryStore(),
      capture: true,
      retirementFactory: true,
      successor: true,
      retirement
    })
    const handler = registerForTest(f.adapter).get(
      PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD
    )
    expect(Boolean(handler)).toBe(retirement)
    if (handler) {
      await expect(handler({}, { clientId: 1, isStale: () => false })).rejects.toThrow()
    }
    expect(f.ptyHandler.beginOwnershipTransferCaptureIngress).not.toHaveBeenCalled()
    expect(f.sourcePublication.prepareCoveredOwnershipTransferRetirement).not.toHaveBeenCalled()
  }
)

it('requires explicit retirement opt-in plus delegated capture and a source cleanup factory', () => {
  expect(() => createAdoption({ retirement: true })).toThrow('retirement_adoption_unavailable')
  expect(() => createAdoption({ store: memoryStore(), capture: true, retirement: true })).toThrow(
    'retirement_adoption_unavailable'
  )
  const disabled = createAdoption({ store: memoryStore(), capture: true, retirementFactory: true })
  expect(
    registerForTest(disabled.adapter).has(PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD)
  ).toBe(false)
  const enabled = createAdoption({
    store: memoryStore(),
    capture: true,
    retirement: true,
    retirementFactory: true
  })
  expect(
    registerForTest(enabled.adapter).has(PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD)
  ).toBe(true)
  expect(enabled.sourcePublication.prepareOwnershipTransferRetirement).not.toHaveBeenCalled()
  expect(
    registerForTest(enabled.adapter).has(PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD)
  ).toBe(false)
})

function registerForTest(adapter: RelayPtyOwnershipTransferAdapter): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>()
  adapter.register({
    onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
    onLegacyPtyCapacity: () => () => {},
    onClientDetached: () => () => {},
    onDisposed: () => () => {}
  } as unknown as RelayDispatcher)
  return handlers
}

function registerStatusForTest(
  adapter: RelayPtyOwnershipTransferAdapter
): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>()
  adapter.registerStatus({
    onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
  } as unknown as RelayDispatcher)
  return handlers
}

async function callAbort(
  handlers: ReadonlyMap<string, MethodHandler>,
  clientId: number
): Promise<unknown> {
  const handler = handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.abort)
  if (!handler) {
    throw new Error('abort handler was not registered for the test')
  }
  return await handler(identity, { clientId, isStale: () => false })
}

describe('dormant relay PTY ownership-transfer runtime adoption', () => {
  it('registers the read-only status probe without exposing mutation RPCs', async () => {
    const { adapter } = createAdoption()
    adapter.prepare(identity)
    adapter.observeOutput(source.terminalId, 'captured')
    const handlers = registerStatusForTest(adapter)
    const status = handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.status)

    expect([...handlers.keys()]).toEqual([PTY_OWNERSHIP_TRANSFER_METHODS.status])
    expect(status).toBeDefined()
    await expect(status!(identity, { clientId: 1, isStale: () => false })).resolves.toMatchObject({
      ...identity,
      phase: 'prepared',
      sourceOutputEndSeq: 1
    })
  })

  it('lets the resumed owner reconcile the exact durable transfer read-only', async () => {
    const { adapter } = createAdoption()
    adapter.prepare(identity)
    adapter.observeOutput(source.terminalId, 'captured')
    const handlers = registerStatusForTest(adapter)
    const status = handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.status)!

    await expect(status(identity, { clientId: 2, isStale: () => false })).resolves.toMatchObject({
      ...identity,
      phase: 'prepared',
      sourceOutputEndSeq: 1
    })
  })

  it('lets the resumed owner reconcile after relay adapter reconstruction', async () => {
    const store = memoryStore()
    const initial = createAdoption({ store }).adapter
    initial.prepare(identity)
    initial.observeOutput(source.terminalId, 'captured before restart')
    initial.commit({
      ...identity,
      acceptedSourceEndSeq: 1,
      receipt: {
        receiptId: 'receipt-before-restart',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 1,
        committedAt: '2026-08-31T12:00:00.000Z'
      }
    })

    const recovered = createAdoption({ store }).adapter
    const status = registerStatusForTest(recovered).get(PTY_OWNERSHIP_TRANSFER_METHODS.status)!
    await expect(status(identity, { clientId: 2, isStale: () => false })).resolves.toMatchObject({
      ...identity,
      phase: 'committed',
      sourceOutputEndSeq: 1,
      acceptedSourceEndSeq: 1,
      commitReceipt: { receiptId: 'receipt-before-restart' }
    })
  })

  it('does not let a resumed owner probe another durable transfer identity', async () => {
    const { adapter } = createAdoption()
    adapter.prepare(identity)
    const status = registerStatusForTest(adapter).get(PTY_OWNERSHIP_TRANSFER_METHODS.status)!

    await expect(
      status(
        { ...identity, destinationRuntimeId: 'another-runtime' },
        { clientId: 2, isStale: () => false }
      )
    ).rejects.toMatchObject({ reason: 'identity-mismatch' })
  })

  it('attaches the observer and enforces the real source input fence', () => {
    const { adapter, ptyHandler } = createAdoption()

    expect(ptyHandler.setOwnershipTransferOutputObserver).toHaveBeenCalledWith(adapter)
    adapter.prepare(identity)
    adapter.commit({
      ...identity,
      acceptedSourceEndSeq: 0,
      receipt: {
        receiptId: 'receipt-1',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        committedAt: '2026-08-30T12:00:00.000Z'
      }
    })
    expect(ptyHandler.setOwnershipTransferInputFenced).toHaveBeenCalledWith('pty-1', true)
    expect(adapter.acceptInput({ ...identity, inputId: 'input-1', data: 'ls\n' })).toEqual({
      accepted: true,
      duplicate: false
    })
    expect(ptyHandler.writeOwnershipTransferInput).toHaveBeenCalledWith('pty-1', 'ls\n')
  })

  it('returns tagged post-commit output to the admitted source-credit route', () => {
    const { adapter } = createAdoption()
    adapter.prepare(identity)
    adapter.commit({
      ...identity,
      acceptedSourceEndSeq: 0,
      receipt: {
        receiptId: 'receipt-output-route',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        committedAt: '2026-08-30T12:00:00.000Z'
      }
    })
    adapter.attach({ ...identity, attachmentId: 'attachment-1' })

    expect(adapter.observeOutput(source.terminalId, 'post-commit')).toEqual([
      expect.objectContaining({
        data: 'post-commit',
        ownershipTransfer: expect.objectContaining({ frameSeq: 1 })
      })
    ])
  })

  it('targets exit delivery to the attached relay client generation', () => {
    const { ptyHandler, sourcePublication } = createAdoption()
    const notify = vi.fn()
    const notifyClient = vi.fn()
    const adapter = adoptDormantRelayPtyOwnershipTransferAdapter(ptyHandler, sourcePublication, {
      notify,
      notifyClient
    } as unknown as RelayDispatcher)
    adapter.prepare(identity)
    adapter.commit({
      ...identity,
      acceptedSourceEndSeq: 0,
      receipt: {
        receiptId: 'receipt-targeted-exit',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        committedAt: '2026-08-30T12:00:00.000Z'
      }
    })
    adapter.attach(
      { ...identity, attachmentId: 'attachment-targeted-exit' },
      { clientId: 17, transportGeneration: 3, isStale: () => false }
    )

    adapter.observeExit(source.terminalId, source.incarnationId, 0)

    expect(notifyClient).toHaveBeenCalledWith(
      17,
      'pty.ownershipTransfer.exit',
      expect.objectContaining({ attachmentId: 'attachment-targeted-exit' })
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps post-commit output fail-closed without an admitted source-credit route', () => {
    const { adapter } = createAdoption({ outputAvailable: false })
    adapter.prepare(identity)
    adapter.commit({
      ...identity,
      acceptedSourceEndSeq: 0,
      receipt: {
        receiptId: 'receipt-output-unavailable',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        committedAt: '2026-08-30T12:00:00.000Z'
      }
    })
    adapter.attach({ ...identity, attachmentId: 'attachment-1' })
    expect(() => adapter.observeOutput(source.terminalId, 'post-commit')).toThrow(
      'pty_ownership_transfer_destination_output_transport_unavailable'
    )
  })

  it.each([
    ['the original owner generation', 1],
    ['a resumed owner generation', 2]
  ])('allows %s to abort the exact prepared transfer', async (_label, clientId) => {
    const { adapter, ptyHandler } = createAdoption()
    adapter.prepare(identity)

    expect(adapter.canRecoverPreparedAbort(identity)).toBe(true)
    await expect(callAbort(registerForTest(adapter), clientId)).resolves.toEqual({
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      phase: 'aborted'
    })
    expect(ptyHandler.setOwnershipTransferInputFenced.mock.calls).toEqual([
      ['pty-1', true],
      ['pty-1', false]
    ])
  })

  it('rejects an unauthorized client without releasing the incumbent fence', async () => {
    const { adapter, ptyHandler } = createAdoption()
    adapter.prepare(identity)

    await expect(callAbort(registerForTest(adapter), 3)).rejects.toMatchObject({
      reason: 'identity-mismatch'
    })
    expect(ptyHandler.setOwnershipTransferInputFenced.mock.calls).toEqual([['pty-1', true]])
  })

  it('does not let the resumed generation continue the old prepared transfer', async () => {
    const { adapter, ptyHandler } = createAdoption()
    adapter.prepare(identity)
    const replay = registerForTest(adapter).get(PTY_OWNERSHIP_TRANSFER_METHODS.replay)
    if (!replay) {
      throw new Error('replay handler was not registered for the test')
    }

    await expect(
      replay({ ...identity, afterSeq: 0 }, { clientId: 2, isStale: () => false })
    ).rejects.toMatchObject({ reason: 'identity-mismatch' })
    expect(ptyHandler.setOwnershipTransferInputFenced.mock.calls).toEqual([['pty-1', true]])
  })

  it('lets the resumed owner atomically rekey and replay only an exact committed transfer', async () => {
    const { adapter } = createAdoption()
    adapter.prepare(identity)
    adapter.commit({
      ...identity,
      acceptedSourceEndSeq: 0,
      receipt: {
        receiptId: 'receipt-resumed-replay',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        committedAt: '2026-08-31T12:00:00.000Z'
      }
    })
    const handlers = registerForTest(adapter)
    const context = {
      clientId: 2,
      transportGeneration: 7,
      isStale: () => false
    }
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect)!(
        {
          ...identity,
          previousReconnectGeneration: 1,
          reconnectGeneration: 2,
          attachmentId: 'attachment-resumed'
        },
        context
      )
    ).resolves.toMatchObject({
      attachmentId: 'attachment-resumed',
      reconnectGeneration: 2,
      phase: 'committed',
      executionVerdict: 'live'
    })
    adapter.observeOutput(source.terminalId, 'retained')

    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.replay)!(
        { ...identity, afterSeq: 0, attachmentId: 'attachment-resumed' },
        context
      )
    ).resolves.toMatchObject({
      phase: 'committed',
      attachmentId: 'attachment-resumed',
      frames: [{ seq: 1, data: 'retained' }]
    })
  })

  it('makes a resumed-owner recovery abort idempotent', async () => {
    const { adapter, ptyHandler } = createAdoption()
    adapter.prepare(identity)
    const handlers = registerForTest(adapter)

    await expect(callAbort(handlers, 2)).resolves.toMatchObject({ phase: 'aborted' })
    await expect(callAbort(handlers, 2)).resolves.toMatchObject({ phase: 'aborted' })
    expect(ptyHandler.setOwnershipTransferInputFenced.mock.calls).toEqual([
      ['pty-1', true],
      ['pty-1', false]
    ])
  })

  it('does not let recovery authorization cross a PTY exit and ID reuse', async () => {
    const { adapter, ptyHandler } = createAdoption()
    adapter.prepare(identity)
    const handlers = registerForTest(adapter)
    adapter.removeTerminal(source.terminalId)
    ptyHandler.resolveOwnershipTransferTerminal.mockReturnValue({
      terminalId: source.terminalId,
      incarnationId: 'incarnation-2'
    })

    await expect(callAbort(handlers, 2)).rejects.toMatchObject({ reason: 'identity-mismatch' })
    expect(ptyHandler.setOwnershipTransferInputFenced.mock.calls).toEqual([
      ['pty-1', true],
      ['pty-1', false]
    ])
  })
})
