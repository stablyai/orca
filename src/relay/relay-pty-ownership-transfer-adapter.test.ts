import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferCommitRequest,
  type PtyOwnershipTransferPrepareRequest
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferPublicationReceipt } from '../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../main/persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import {
  RelayPtyOwnershipTransferAdapter,
  type RelayPtyOwnershipTransferAdapterOptions,
  type RelayPtyOwnershipTransferSource
} from './relay-pty-ownership-transfer-adapter'

const source: RelayPtyOwnershipTransferSource = {
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 4
}

const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'pty-1'
}

const destinationIdentity = {
  bridgeId: 'bridge-1',
  terminalId: source.terminalId,
  incarnationId: source.incarnationId,
  ownerLease: source.ownerLease,
  sourceOwnerGeneration: source.sourceOwnerGeneration,
  destinationRuntimeId: 'bun-runtime-1'
} as const

let outputOutboxDirectory: string

beforeEach(() => {
  outputOutboxDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-transfer-output-'))
})

afterEach(() => {
  rmSync(outputOutboxDirectory, { recursive: true, force: true })
})

function prepareRequest(overrides: Partial<PtyOwnershipTransferPrepareRequest> = {}) {
  return {
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    bridgeId: 'bridge-1',
    terminalId: source.terminalId,
    incarnationId: source.incarnationId,
    ownerLease: source.ownerLease,
    sourceOwnerGeneration: source.sourceOwnerGeneration,
    destinationRuntimeId: 'bun-runtime-1',
    surfacePublication: { version: 1 as const, surfaceBinding },
    ...overrides
  }
}

function commitRequest(
  acceptedSourceEndSeq: number,
  receiptId = 'receipt-1'
): PtyOwnershipTransferCommitRequest {
  const committedAt = '2026-08-30T00:00:00.000Z'
  return {
    ...prepareRequest(),
    acceptedSourceEndSeq,
    receipt: {
      receiptId,
      bridgeId: 'bridge-1',
      acceptedSourceEndSeq,
      committedAt
    }
  }
}

function publicationRequest(
  options: Readonly<{
    omitSurface?: boolean
    surfaceBinding?: PtyOwnershipTransferSurfaceBinding
  }> = {}
): PtyOwnershipTransferPublicationReceipt {
  const committedAt = '2026-08-30T00:00:00.000Z'
  return {
    version: 1,
    publicationReceiptId: 'publication-1',
    bridgeId: 'bridge-1',
    destinationRuntimeId: 'bun-runtime-1',
    commitReceipt: {
      receiptId: 'receipt-1',
      bridgeId: 'bridge-1',
      acceptedSourceEndSeq: 2,
      committedAt
    },
    publishedAt: '2026-08-30T00:00:01.000Z',
    ...(options.omitSurface ? {} : { surfaceBinding: options.surfaceBinding ?? surfaceBinding })
  }
}

function createAdapter(options: Partial<RelayPtyOwnershipTransferAdapterOptions> = {}) {
  const sourceWrites: string[] = []
  const publishedFrames: string[] = []
  const adapter = new RelayPtyOwnershipTransferAdapter({
    replayBytes: 128,
    resolveSource: (terminalId) => (terminalId === source.terminalId ? source : null),
    authorizeRequest: () => true,
    setInputFenced: vi.fn(),
    writeDestinationInput: (_id, data) => sourceWrites.push(data),
    publishDestinationOutput: (_identity, _attachmentId, frame) => {
      publishedFrames.push(frame.data)
    },
    ...options
  })
  return { adapter, sourceWrites, publishedFrames }
}

function registerForTest(adapter: RelayPtyOwnershipTransferAdapter): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>()
  adapter.register({
    onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
  } as unknown as RelayDispatcher)
  return handlers
}

function deferredAuthorization() {
  let resolve!: (authorized: boolean) => void
  const promise = new Promise<boolean>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function registeredHandler(
  handlers: ReadonlyMap<string, MethodHandler>,
  method: (typeof PTY_OWNERSHIP_TRANSFER_METHODS)[keyof typeof PTY_OWNERSHIP_TRANSFER_METHODS]
): MethodHandler {
  const handler = handlers.get(method)
  if (!handler) {
    throw new Error(`${method} handler was not registered for the test`)
  }
  return handler
}

describe('RelayPtyOwnershipTransferAdapter', () => {
  it('does not prepare or fence input when authorization resolves after the request is stale', async () => {
    const authorization = deferredAuthorization()
    const setInputFenced = vi.fn()
    const { adapter } = createAdapter({
      authorizeRequest: () => authorization.promise,
      setInputFenced
    })
    let stale = false
    const prepare = registeredHandler(
      registerForTest(adapter),
      PTY_OWNERSHIP_TRANSFER_METHODS.prepare
    )

    const result = prepare(prepareRequest(), { clientId: 1, isStale: () => stale })
    stale = true
    authorization.resolve(true)

    await expect(result).rejects.toMatchObject({ reason: 'stale-request' })
    expect(setInputFenced).not.toHaveBeenCalled()
    expect(adapter.snapshot('bridge-1')).toBeNull()
  })

  it('keeps a prepared transfer fenced when abort authorization resolves after staleness', async () => {
    const authorization = deferredAuthorization()
    const setInputFenced = vi.fn()
    const { adapter } = createAdapter({
      authorizeRequest: () => authorization.promise,
      setInputFenced
    })
    adapter.prepare(prepareRequest())
    let stale = false
    const abort = registeredHandler(registerForTest(adapter), PTY_OWNERSHIP_TRANSFER_METHODS.abort)

    const result = abort(prepareRequest(), { clientId: 1, isStale: () => stale })
    stale = true
    authorization.resolve(true)

    await expect(result).rejects.toMatchObject({ reason: 'stale-request' })
    expect(setInputFenced.mock.calls).toEqual([['pty-1', true]])
    expect(adapter.snapshot('bridge-1')).toMatchObject({ phase: 'prepared' })
  })

  it('fences source input, replays sequenced output, and gates publication on exact receipts', () => {
    const committed = vi.fn()
    const published = vi.fn()
    const { adapter, sourceWrites, publishedFrames } = createAdapter({
      onCommitted: committed,
      onPublished: published
    })
    adapter.observeOutput(source.terminalId, 'before')
    expect(adapter.prepare(prepareRequest())).toMatchObject({
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1
    })
    adapter.observeOutput(source.terminalId, 'during')

    const replay = adapter.replay({ ...prepareRequest(), afterSeq: 0 })
    expect(replay.frames.map((frame) => frame.data)).toEqual(['before', 'during'])
    expect(replay.sourceOutputEndSeq).toBe(2)
    expect(() => adapter.commit(commitRequest(1))).toThrow(
      expect.objectContaining({ reason: 'destination-not-caught-up' })
    )

    expect(adapter.commit(commitRequest(2))).toMatchObject({ phase: 'committed' })
    expect(committed).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: 'bridge-1' }))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-1' })
    adapter.observeOutput(source.terminalId, 'after-commit')
    expect(publishedFrames).toEqual(['after-commit'])
    expect(() =>
      adapter.acceptInput({ ...prepareRequest(), inputId: 'i-1', data: 'ls\n' })
    ).not.toThrow()
    expect(adapter.acceptInput({ ...prepareRequest(), inputId: 'i-1', data: 'ls\n' })).toEqual({
      accepted: false,
      duplicate: true
    })
    expect(sourceWrites).toEqual(['ls\n'])

    const publication = publicationRequest()
    expect(adapter.publish({ ...prepareRequest(), publicationReceipt: publication })).toMatchObject(
      {
        phase: 'published'
      }
    )
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: 'bridge-1' }))
    expect(adapter.publish({ ...prepareRequest(), publicationReceipt: publication })).toMatchObject(
      {
        phase: 'published'
      }
    )
    expect(adapter.retireInput({ ...prepareRequest(), inputIds: ['i-1', 'missing'] })).toEqual({
      retired: 1
    })
    expect(adapter.acceptInput({ ...prepareRequest(), inputId: 'i-1', data: 'whoami\n' })).toEqual({
      accepted: true,
      duplicate: false
    })
  })

  it('replays retained published output only through the rekeyed attachment generation', () => {
    const { adapter } = createAdapter()
    adapter.observeOutput(source.terminalId, 'one')
    adapter.prepare(prepareRequest())
    adapter.observeOutput(source.terminalId, 'two')
    adapter.commit(commitRequest(2))
    adapter.publish({
      ...prepareRequest(),
      publicationReceipt: publicationRequest()
    })
    adapter.attach(
      { ...prepareRequest(), attachmentId: 'attachment-rekeyed' },
      { clientId: 7, transportGeneration: 4, isStale: () => false }
    )
    adapter.observeOutput(source.terminalId, 'three')
    const replayRequest = {
      ...prepareRequest(),
      afterSeq: 2,
      attachmentId: 'attachment-rekeyed'
    }

    expect(
      adapter.replay(replayRequest, {
        clientId: 7,
        transportGeneration: 4,
        isStale: () => false
      })
    ).toMatchObject({
      phase: 'published',
      attachmentId: 'attachment-rekeyed',
      sourceOutputEndSeq: 3,
      frames: [{ seq: 3, data: 'three' }]
    })
    expect(() =>
      adapter.replay(replayRequest, {
        clientId: 7,
        transportGeneration: 5,
        isStale: () => false
      })
    ).toThrow(expect.objectContaining({ reason: 'stale-attachment' }))
    expect(() => adapter.replay({ ...replayRequest, attachmentId: undefined })).toThrow(
      expect.objectContaining({ reason: 'stale-attachment' })
    )
  })

  it('advances reconnect routes monotonically and makes an exact retry idempotent', () => {
    const { adapter } = createAdapter()
    adapter.prepare(prepareRequest())
    adapter.commit(commitRequest(0))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-4' })
    const request = {
      ...prepareRequest(),
      previousReconnectGeneration: 4,
      reconnectGeneration: 5,
      attachmentId: 'attachment-5'
    }

    expect(adapter.rekeyReconnect(request)).toMatchObject({
      phase: 'committed',
      reconnectGeneration: 5,
      attachmentId: 'attachment-5',
      executionVerdict: 'live'
    })
    expect(adapter.rekeyReconnect(request)).toMatchObject({ reconnectGeneration: 5 })
    expect(() =>
      adapter.rekeyReconnect({ ...request, attachmentId: 'conflicting-attachment' })
    ).toThrow(expect.objectContaining({ reason: 'stale-reconnect-generation' }))
    expect(() =>
      adapter.rekeyReconnect({
        ...request,
        reconnectGeneration: 6,
        attachmentId: 'attachment-6'
      })
    ).toThrow(expect.objectContaining({ reason: 'stale-reconnect-generation' }))
    expect(adapter.status(prepareRequest())).toMatchObject({ reconnectGeneration: 5 })
  })

  it('rolls back the in-memory route when durable rekey persistence fails', () => {
    let fail = false
    const records: unknown[] = []
    const { adapter } = createAdapter({
      store: {
        loadAll: () => [],
        save: (record) => {
          if (fail) {
            throw new Error('route-disk-full')
          }
          records.push(structuredClone(record))
        },
        remove: () => undefined
      }
    })
    adapter.prepare(prepareRequest())
    adapter.commit(commitRequest(0))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-4' })
    fail = true

    expect(() =>
      adapter.rekeyReconnect({
        ...prepareRequest(),
        previousReconnectGeneration: 4,
        reconnectGeneration: 5,
        attachmentId: 'attachment-5'
      })
    ).toThrow('route-disk-full')
    expect(adapter.status(prepareRequest())).toMatchObject({ reconnectGeneration: 4 })
    expect(records).toHaveLength(3)
  })

  it('reuses the same output sequence when a committed publication is retried', () => {
    const publicationAttempts: { seq: number; data: string }[] = []
    const failuresBySeq = new Set<number>()
    const { adapter } = createAdapter({
      publishDestinationOutput: (_identity, _attachmentId, frame) => {
        publicationAttempts.push(frame)
        if (!failuresBySeq.has(frame.seq)) {
          failuresBySeq.add(frame.seq)
          throw new Error('destination unavailable')
        }
      }
    })
    adapter.prepare(prepareRequest())
    adapter.commit(commitRequest(0))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-1' })

    expect(() => adapter.observeOutput(source.terminalId, 'first', '1:1')).toThrow(
      'destination unavailable'
    )
    expect(adapter.observeOutput(source.terminalId, 'first', '1:1')).toEqual([
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 1 }) })
    ])
    expect(() => adapter.observeOutput(source.terminalId, 'second', '2:2')).toThrow(
      'destination unavailable'
    )
    expect(adapter.observeOutput(source.terminalId, 'second', '2:2')).toEqual([
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 2 }) })
    ])
    expect(publicationAttempts).toEqual([
      { seq: 1, data: 'first' },
      { seq: 1, data: 'first' },
      { seq: 2, data: 'second' },
      { seq: 2, data: 'second' }
    ])
  })

  it('keeps overlapping failed emissions keyed so an earlier retry cannot mint new sequences', () => {
    const publicationAttempts: { seq: number; data: string }[] = []
    let failFirstEmission = true
    const { adapter } = createAdapter({
      publishDestinationOutput: (_identity, _attachmentId, frame) => {
        publicationAttempts.push(frame)
        if (failFirstEmission && frame.seq === 1) {
          failFirstEmission = false
          throw new Error('destination unavailable')
        }
      }
    })
    adapter.prepare(prepareRequest())
    adapter.commit(commitRequest(0))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-1' })

    expect(() => adapter.observeOutput(source.terminalId, 'first', 'emission-1')).toThrow(
      'destination unavailable'
    )
    expect(adapter.observeOutput(source.terminalId, 'second', 'emission-2')).toEqual([
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 2 }) })
    ])
    expect(adapter.observeOutput(source.terminalId, 'first', 'emission-1')).toEqual([
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 1 }) })
    ])
    expect(publicationAttempts).toEqual([
      { seq: 1, data: 'first' },
      { seq: 2, data: 'second' },
      { seq: 1, data: 'first' }
    ])
  })

  it('retries a partially accepted multi-frame emission against the durable destination outbox', () => {
    const outbox = new PtyOwnershipTransferDestinationOutputOutbox({
      directory: outputOutboxDirectory
    })
    outbox.open(destinationIdentity, 0)
    let failBeforeSecondAcceptance = true
    const publicationAttempts: number[] = []
    const { adapter } = createAdapter({
      publishDestinationOutput: (identity, _attachmentId, frame) => {
        publicationAttempts.push(frame.seq)
        if (failBeforeSecondAcceptance && frame.seq === 2) {
          failBeforeSecondAcceptance = false
          throw new Error('destination disconnected before frame acceptance')
        }
        outbox.enqueue(identity, frame)
      }
    })
    adapter.prepare(prepareRequest())
    adapter.commit(commitRequest(0))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-1' })

    const firstFrame = 'x'.repeat(16 * 1024)
    expect(() => adapter.observeOutput(source.terminalId, `${firstFrame}y`, 'emission-1')).toThrow(
      'destination disconnected before frame acceptance'
    )
    expect(outbox.load(destinationIdentity)).toMatchObject({
      acknowledgedEndSeq: 0,
      acceptedEndSeq: 1,
      pendingFrames: [{ seq: 1, data: firstFrame }]
    })
    expect(adapter.observeOutput(source.terminalId, `${firstFrame}y`, 'emission-1')).toEqual([
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 1 }) }),
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 2 }) })
    ])
    expect(publicationAttempts).toEqual([1, 2, 1, 2])
    expect(outbox.load(destinationIdentity)).toMatchObject({
      acknowledgedEndSeq: 0,
      acceptedEndSeq: 2,
      pendingFrames: [
        { seq: 1, data: firstFrame },
        { seq: 2, data: 'y' }
      ]
    })

    const acknowledged = outbox.acknowledge(destinationIdentity, 2)
    expect(acknowledged).toMatchObject({
      acknowledgedEndSeq: 2,
      acceptedEndSeq: 2,
      pendingFrames: []
    })
  })

  it('refuses stale identities, transfer conflicts, and changed receipts', () => {
    const { adapter } = createAdapter()
    adapter.prepare(prepareRequest())
    expect(() => adapter.prepare(prepareRequest({ ownerLease: 'other-lease' }))).toThrow(
      expect.objectContaining({ reason: 'identity-mismatch' })
    )
    expect(() => adapter.prepare(prepareRequest({ bridgeId: 'bridge-2' }))).toThrow(
      expect.objectContaining({ reason: 'already-transferring' })
    )
    adapter.observeOutput(source.terminalId, 'output')
    adapter.commit(commitRequest(1))
    expect(() => adapter.commit(commitRequest(1, 'changed'))).toThrow(
      expect.objectContaining({ reason: 'receipt-invalid' })
    )
    expect(() => adapter.abort(prepareRequest())).toThrow(
      expect.objectContaining({ reason: 'invalid-phase' })
    )
  })

  it('requires the exact negotiated surface proof in the publication receipt', () => {
    const { adapter } = createAdapter()
    adapter.prepare(prepareRequest())
    adapter.observeOutput(source.terminalId, 'output')
    adapter.commit(commitRequest(1))

    expect(() =>
      adapter.publish({
        ...prepareRequest(),
        publicationReceipt: publicationRequest({ omitSurface: true })
      })
    ).toThrow(expect.objectContaining({ reason: 'receipt-invalid' }))
    expect(() =>
      adapter.publish({
        ...prepareRequest(),
        publicationReceipt: publicationRequest({
          surfaceBinding: { ...surfaceBinding, tabId: 'other-tab' }
        })
      })
    ).toThrow(expect.objectContaining({ reason: 'receipt-invalid' }))
  })

  it('echoes additive negotiation and keeps legacy prepare requests parseable', () => {
    const { adapter } = createAdapter()
    const negotiated = adapter.prepare(prepareRequest())
    expect(negotiated.surfacePublication).toEqual({ version: 1, surfaceBinding })
    expect(() =>
      adapter.prepare(
        prepareRequest({
          surfacePublication: {
            version: 1,
            surfaceBinding: { ...surfaceBinding, tabId: 'changed-tab' }
          }
        })
      )
    ).toThrow(expect.objectContaining({ reason: 'identity-mismatch' }))

    const legacy = createAdapter().adapter.prepare(
      prepareRequest({ surfacePublication: undefined })
    )
    expect(legacy).not.toHaveProperty('surfacePublication')
  })

  it('keeps replay bounded and makes an unavailable checkpoint fail closed', () => {
    const { adapter } = createAdapter({ replayBytes: 4 })
    adapter.observeOutput(source.terminalId, 'one')
    adapter.observeOutput(source.terminalId, 'two')
    const prepared = adapter.prepare(prepareRequest())
    expect(prepared.replayStartSeq).toBe(2)
    expect(() => adapter.replay({ ...prepareRequest(), afterSeq: 0 })).toThrow(
      expect.objectContaining({ reason: 'replay-unavailable' })
    )
    expect(
      adapter.replay({ ...prepareRequest(), afterSeq: 1 }).frames.map((frame) => frame.data)
    ).toEqual(['two'])
  })

  it('aborts idempotently and releases the input fence', () => {
    const unfenced: boolean[] = []
    const { adapter } = createAdapter({ setInputFenced: (_id, fenced) => unfenced.push(fenced) })
    adapter.prepare(prepareRequest())
    expect(adapter.abort(prepareRequest())).toEqual({
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      phase: 'aborted'
    })
    expect(adapter.abort(prepareRequest())).toEqual({
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      phase: 'aborted'
    })
    expect(unfenced).toEqual([true, false])
    expect(() => adapter.replay({ ...prepareRequest(), afterSeq: 0 })).toThrow(
      expect.objectContaining({ reason: 'invalid-phase' })
    )
  })

  it('returns an exact status snapshot for recovery probes', async () => {
    const { adapter } = createAdapter()
    adapter.observeOutput(source.terminalId, 'output')
    adapter.prepare(prepareRequest())
    adapter.commit(commitRequest(1))
    adapter.attach({ ...prepareRequest(), attachmentId: 'attachment-1' })
    adapter.observeOutput(source.terminalId, 'post-commit')

    expect(
      adapter.status({ ...prepareRequest(), version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION })
    ).toMatchObject({
      bridgeId: 'bridge-1',
      phase: 'committed',
      sourceOutputEndSeq: 2,
      replayStartSeq: 1,
      acceptedSourceEndSeq: 1,
      reconnectGeneration: 4,
      commitReceipt: expect.objectContaining({ receiptId: 'receipt-1' }),
      surfacePublication: { version: 1, surfaceBinding }
    })

    const status = registeredHandler(
      registerForTest(adapter),
      PTY_OWNERSHIP_TRANSFER_METHODS.status
    )
    await expect(
      status({ ...prepareRequest() }, { clientId: 1, isStale: () => false })
    ).resolves.toMatchObject({
      phase: 'committed',
      acceptedSourceEndSeq: 1
    })
  })
})
