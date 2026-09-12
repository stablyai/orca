import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import type {
  RelayPtyOwnershipTransferAdapterOptions,
  RelayPtyOwnershipTransferDurableRecord
} from './relay-pty-ownership-transfer-adapter-contract'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD as ACK,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD as COMMIT,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD as RECOVER,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD as STATUS,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD as CLAIM,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD as REPLAY,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD as SUBSCRIBE
} from '../shared/pty-ownership-transfer-destination-claim'

describe('claim-bound delegated commit', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  let failure: 'none' | 'before' | 'after'
  beforeEach(() => {
    vi.useFakeTimers()
    directory = mkdtempSync(join(tmpdir(), 'orca-delegated-commit-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
    failure = 'none'
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })
  function setup(patch: Partial<RelayPtyOwnershipTransferAdapterOptions> = {}) {
    const legacyOutput = vi.fn()
    const fence = vi.fn()
    const adapter = makeDelegatedRelay(
      {
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record: RelayPtyOwnershipTransferDurableRecord) => {
          if (failure !== 'before') {
            store.save(record)
          }
          if (failure !== 'none') {
            throw new Error('uncertain write')
          }
        }
      },
      {
        enableDestinationOutputRetention: true,
        enableDestinationOutputRoutes: true,
        enableDestinationDelegationCommit: true,
        replayBytes: 32,
        resolveTerminalIncarnation: () => identity.incarnationId,
        hasPendingSourceOutput: () => false,
        publishDestinationOutput: legacyOutput,
        setInputFenced: fence,
        ...patch
      }
    )
    const handlers = new Map<string, MethodHandler>()
    const publish = vi.fn(() => true)
    adapter.register({
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
      onLegacyPtyCapacity: () => () => {},
      onClientDetached: () => () => {},
      onDisposed: () => () => {},
      publishProducerNotification: publish
    } as unknown as RelayDispatcher)
    const call = async (method: string, value: Record<string, unknown>, caller = context()) =>
      handlers.get(method)!(value, caller)
    const cursor = (afterSeq: number, generation = 1) => ({
      ...request(generation),
      afterSeq,
      destinationClaim: { generation, claimId: `claim-${generation}` }
    })
    const commit = (generation = 1, receiptId = 'receipt-1') =>
      call(COMMIT, {
        ...cursor(1, generation),
        acceptedSourceEndSeq: 1,
        receipt: {
          version: 1,
          bridgeId: identity.bridgeId,
          acceptedSourceEndSeq: 1,
          receiptId,
          committedAt: '2026-09-06T00:00:00.000Z'
        }
      })
    const prepare = async () => {
      adapter.prepare(preparation)
      adapter.claimDestination(request(), context())
      adapter.observeOutput(identity.terminalId, 'before')
      await call(SUBSCRIBE, cursor(0))
      vi.runAllTimers()
      await call(ACK, cursor(1))
    }
    return { adapter, handlers, call, cursor, commit, prepare, publish, legacyOutput, fence }
  }

  it('commits once and streams subsequent output without a desktop attachment', async () => {
    const fixture = setup()
    expect(fixture.adapter.fencesLegacyAttachment(identity.terminalId)).toBe(false)
    await fixture.prepare()
    expect(fixture.adapter.fencesLegacyAttachment(identity.terminalId)).toBe(true)
    const committed = await fixture.commit()
    expect(store.loadAll()[0]).toMatchObject({
      version: 5,
      phase: 'committed',
      committedSourceOutputEndSeq: 1
    })
    expect(fixture.adapter.ownsOutputPublication(identity.terminalId)).toBe(true)
    expect(fixture.adapter.fencesLegacyAttachment(identity.terminalId)).toBe(true)
    fixture.adapter.observeOutput(identity.terminalId, 'after')
    expect(store.loadAll()[0]).toMatchObject({
      sourceOutputEndSeq: 2,
      committedSourceOutputEndSeq: 1
    })
    vi.runAllTimers()
    expect(fixture.publish.mock.calls).toHaveLength(2)
    expect(fixture.legacyOutput).not.toHaveBeenCalled()
    await expect(fixture.commit()).resolves.toEqual(committed)
    await expect(fixture.commit(1, 'different')).rejects.toThrow('receipt_invalid')
    expect(() =>
      fixture.adapter.commit({
        ...request(),
        acceptedSourceEndSeq: 1,
        receipt: (committed as { receipt: unknown }).receipt
      })
    ).toThrow('delegation_commit_unavailable')
    expect(() => fixture.adapter.abort(preparation)).toThrow()
    const restored = setup()
    expect(store.loadAll()[0].committedSourceOutputEndSeq).toBe(1)
    restored.adapter.claimDestination(request(2), context())
    await expect(restored.commit(2)).resolves.toEqual(committed)
    await expect(restored.call(REPLAY, restored.cursor(1, 2))).resolves.toMatchObject({
      phase: 'committed',
      frames: [{ seq: 2, data: 'after' }]
    })
    expect(await restored.call(REPLAY, restored.cursor(1, 2))).not.toHaveProperty('credential')
    expect(restored.adapter.inspectDestination(request(), context())).toMatchObject({
      phase: 'committed',
      receipt: (committed as { receipt: unknown }).receipt
    })
  })

  it.each([0, 1])(
    'preserves selected baseline %s while committing after later output catch-up',
    async (throughSeq) => {
      const fixture = setup()
      fixture.adapter.prepare(preparation)
      if (throughSeq === 1) {
        fixture.adapter.observeOutput(identity.terminalId, 'before')
      }
      const boundary = {
        version: 1 as const,
        identity,
        throughSeq,
        delivery: {
          id: identity.terminalId,
          ptyIncarnation: identity.incarnationId,
          providerGeneration: 1,
          clientGeneration: 1,
          ownerGeneration: identity.sourceOwnerGeneration,
          deliveryToken: 'captured',
          state: 'active' as const,
          windowSu: 256,
          receivedEndSu: throughSeq * 6,
          sentEndSu: throughSeq * 6,
          creditedEndSu: throughSeq * 6,
          generationClosed: false as const,
          exitPublished: false as const
        }
      }
      const baseline = { version: 1, boundary, modelSha256: 'a'.repeat(64) }
      fixture.adapter.selectCaptureBaseline(identity, baseline, () => boundary)
      fixture.adapter.claimDestination(request(), context())
      if (throughSeq === 0) {
        fixture.adapter.observeOutput(identity.terminalId, 'after')
      }
      await fixture.call(SUBSCRIBE, fixture.cursor(0))
      vi.runAllTimers()
      await fixture.call(ACK, fixture.cursor(1))
      const commit = (acceptedSourceEndSeq: number) =>
        fixture.call(COMMIT, {
          ...fixture.cursor(1),
          acceptedSourceEndSeq,
          receipt: {
            bridgeId: identity.bridgeId,
            acceptedSourceEndSeq,
            receiptId: 'captured-commit',
            committedAt: '2026-09-06T00:00:00.000Z'
          }
        })
      await expect(commit(1 - throughSeq)).rejects.toThrow('cursor_invalid')
      await expect(commit(throughSeq)).resolves.toMatchObject({ phase: 'committed' })
      expect(store.loadAll()[0]).toMatchObject({
        version: 9,
        captureJournalVersion: 5,
        captureBaseline: baseline,
        sourceOutputEndSeq: 1,
        commitReceipt: { acceptedSourceEndSeq: throughSeq }
      })
      const reopened = makeDelegatedRelay(store, { enableDestinationOutputRetention: true })
      reopened.claimDestination(request(2), context())
      expect(store.loadAll()[0]).toMatchObject({
        version: 9,
        captureJournalVersion: 5,
        captureBaseline: baseline
      })
    }
  )

  it.each(['before', 'after'] as const)(
    'retains exact committed ownership after an uncertain %s-write failure',
    async (when) => {
      const fixture = setup()
      await fixture.prepare()
      failure = when
      await expect(fixture.commit()).rejects.toThrow('uncertain write')
      expect(fixture.adapter.ownsOutputPublication(identity.terminalId)).toBe(true)
      await expect(fixture.commit()).rejects.toThrow('claim_unavailable')
      expect(fixture.fence).not.toHaveBeenCalledWith(identity.terminalId, false)
      failure = 'none'
      fixture.adapter.observeOutput(identity.terminalId, 'during recovery')
      expect(fixture.legacyOutput).not.toHaveBeenCalled()
      const recovered = fixture.adapter.recoverDestination(request(), context())
      expect(recovered).toMatchObject({
        phase: 'committed',
        boundToConnection: false,
        receipt: { receiptId: 'receipt-1' }
      })
      fixture.adapter.claimDestination(request(2), context())
      await expect(fixture.commit(2)).resolves.toMatchObject({
        receipt: { receiptId: 'receipt-1' }
      })
      expect(store.loadAll()[0]).toMatchObject({ version: 5, phase: 'committed' })
    }
  )

  it.each([
    ['before', 'before'],
    ['before', 'after'],
    ['after', 'before'],
    ['after', 'after']
  ] as const)(
    'keeps both routes fenced after %s commit failure and %s recovery failure',
    async (commitFailure, recoveryFailure) => {
      const fixture = setup()
      await fixture.prepare()
      failure = commitFailure
      await expect(fixture.commit()).rejects.toThrow('uncertain write')
      failure = recoveryFailure
      await expect(fixture.call(RECOVER, request())).rejects.toThrow('uncertain write')
      await expect(fixture.call(STATUS, request())).rejects.toThrow('claim_unavailable')
      await expect(fixture.call(CLAIM, request(2))).rejects.toThrow('claim_unavailable')
      await expect(fixture.commit()).rejects.toThrow('claim_unavailable')
      expect(fixture.adapter.fencesLegacyAttachment(identity.terminalId)).toBe(true)
      expect(fixture.adapter.ownsOutputPublication(identity.terminalId)).toBe(true)
      expect(fixture.fence).not.toHaveBeenCalledWith(identity.terminalId, false)
      failure = 'none'
      fixture.adapter.observeOutput(identity.terminalId, 'retained during failed recovery')
      await expect(fixture.call(RECOVER, request())).resolves.toMatchObject({
        phase: 'committed',
        boundToConnection: false,
        receipt: { receiptId: 'receipt-1' }
      })
      await expect(fixture.commit()).rejects.toThrow('commit_unavailable')
      await fixture.call(CLAIM, request(2))
      await expect(fixture.commit(2)).resolves.toMatchObject({
        receipt: { receiptId: 'receipt-1' }
      })
      const restored = setup()
      await restored.call(CLAIM, request(3))
      await expect(restored.call(REPLAY, restored.cursor(1, 3))).resolves.toMatchObject({
        phase: 'committed',
        frames: [{ seq: 2, data: 'retained during failed recovery' }]
      })
      expect(fixture.legacyOutput).not.toHaveBeenCalled()
      expect(restored.legacyOutput).not.toHaveBeenCalled()
    }
  )

  it.each([
    { hasPendingSourceOutput: undefined },
    { hasPendingSourceOutput: () => true },
    { resolveTerminalIncarnation: undefined }
  ])('refuses commit without host-owned ingress and incarnation evidence (%j)', async (patch) => {
    const fixture = setup(patch)
    await fixture.prepare()
    await expect(fixture.commit()).rejects.toThrow('source_unverifiable')
    expect(store.loadAll()[0].phase).toBe('prepared')
  })

  it.each(['credential', 'stale', 'unauthenticated'] as const)(
    'does not reflush uncertain commit for a rejected %s recovery caller',
    async (rejected) => {
      const fixture = setup()
      await fixture.prepare()
      failure = 'before'
      await expect(fixture.commit()).rejects.toThrow('uncertain write')
      failure = 'none'
      const save = vi.spyOn(store, 'save')
      const caller = context()
      if (rejected === 'stale') {
        caller.isStale = () => true
      }
      if (rejected === 'unauthenticated') {
        caller.sessionIdentity = { ...caller.sessionIdentity!, authenticated: false }
      }
      const proof = {
        ...request(),
        ...(rejected === 'credential' ? { credential: '0'.repeat(64) } : {})
      }
      await expect(fixture.call(RECOVER, proof, caller)).rejects.toThrow('unauthorized')
      expect(save).not.toHaveBeenCalled()
      expect(store.loadAll()[0].phase).toBe('prepared')
      await expect(fixture.call(STATUS, request())).rejects.toThrow('claim_unavailable')
      await expect(fixture.call(RECOVER, request())).resolves.toMatchObject({
        phase: 'committed',
        boundToConnection: false
      })
      expect(save).toHaveBeenCalledOnce()
      expect(store.loadAll()[0].phase).toBe('committed')
      expect(fixture.adapter.fencesLegacyAttachment(identity.terminalId)).toBe(true)
    }
  )

  it('refuses commit when the physical terminal incarnation changes after catch-up', async () => {
    const resolveTerminalIncarnation = vi.fn(() => identity.incarnationId)
    const fixture = setup({ resolveTerminalIncarnation })
    await fixture.prepare()
    resolveTerminalIncarnation.mockReturnValue('different')
    await expect(fixture.commit()).rejects.toThrow('source_unverifiable')
    expect(store.loadAll()[0].phase).toBe('prepared')
  })

  it('requires both an active output subscription and a durable caught-up ACK', async () => {
    const fixture = setup()
    fixture.adapter.prepare(preparation)
    fixture.adapter.claimDestination(request(), context())
    fixture.adapter.observeOutput(identity.terminalId, 'before')
    await fixture.call(REPLAY, fixture.cursor(0))
    await fixture.call(ACK, fixture.cursor(1))
    await expect(fixture.commit()).rejects.toThrow('source_unverifiable')
    await fixture.call(SUBSCRIBE, fixture.cursor(1))
    fixture.adapter.observeOutput(identity.terminalId, 'new')
    await expect(fixture.commit()).rejects.toThrow('cursor_invalid')
  })

  it('does not register commit when its implementation gate is disabled', () => {
    expect(setup({ enableDestinationDelegationCommit: false }).handlers.has(COMMIT)).toBe(false)
  })

  it('recovers an older destination receipt only after all newer source output is ACKed', async () => {
    const fixture = setup()
    await fixture.prepare()
    fixture.adapter.observeOutput(identity.terminalId, 'newer')
    await expect(fixture.commit()).rejects.toThrow('cursor_invalid')
    vi.runAllTimers()
    await fixture.call(ACK, fixture.cursor(2))
    await expect(fixture.commit()).resolves.toMatchObject({ receipt: { acceptedSourceEndSeq: 1 } })
    expect(store.loadAll()[0]).toMatchObject({
      sourceOutputEndSeq: 2,
      commitReceipt: { acceptedSourceEndSeq: 1 }
    })
  })
})
