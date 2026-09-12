import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { registerRelayPtySuccessorRetirement } from './relay-pty-successor-retirement-registration'
import {
  PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD,
  parsePtyOwnershipTransferSuccessorRetirementResult
} from '../shared/pty-ownership-transfer-successor-retirement'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PtyOwnershipCaptureIngressFence } from './pty-ownership-capture-ingress-fence'

it.each(['none', 'cancel-throw', 'ingress-before', 'ingress-after'] as const)(
  'retires real window-blocked delivery with durable custody (interruption=%s)',
  async (interruption) => {
    const interrupted = interruption !== 'none'
    const source = await createSourceRetirementPublicationFixture()
    const directory = mkdtempSync(join(tmpdir(), 'orca-covered-retirement-integration-'))
    try {
      const identity = { ...source.source, bridgeId: 'bridge', destinationRuntimeId: 'destination' }
      const store = new RelayPtyOwnershipTransferFileStore(directory)
      const options = {
        store,
        enableDestinationOutputRetention: true,
        resolveSource: (id: string) => source.publication.ownershipTransfer.resolve(id),
        resolveTerminalIncarnation: () => identity.incarnationId,
        hasPendingSourceOutput: () => false,
        authorizeRequest: () => false,
        setInputFenced: () => {},
        writeDestinationInput: () => {},
        publishDestinationOutput: () => {}
      }
      const relay = makeDelegatedRelay(store, options)
      relay.prepare({
        ...preparation,
        ...identity,
        surfacePublication: {
          ...preparation.surfacePublication,
          surfaceBinding: {
            ...preparation.surfacePublication.surfaceBinding,
            ptyId: identity.terminalId
          }
        }
      })
      const baseline = parsePtyOwnershipCaptureBaseline(
        {
          version: 1,
          modelSha256: 'a'.repeat(64),
          boundary: { version: 1, identity, throughSeq: 0, delivery: source.prepare().delivery }
        },
        identity
      )
      relay.retainCaptureBoundary(identity, baseline.boundary, 100)
      relay.selectCaptureBaseline(identity, baseline, () => baseline.boundary)
      relay.observeOutput('source', 'one🙂', '100:400', undefined, {
        emissionId: '100:400',
        rawStartSu: 100,
        rawEndSu: 400,
        displayStartSu: 0,
        displayEndSu: 5,
        displayLengthSu: 5
      })
      source.publication.publish('source', { data: 'x'.repeat(300) }, false)
      await new Promise((resolve) => setImmediate(resolve))
      const actual = source.session.sourceDeliverySnapshotIfKnown(baseline.boundary.delivery)!
      expect(actual).toMatchObject({ receivedEndSu: 300, sentEndSu: 256, creditedEndSu: 0 })
      let state = newRelayPtyOwnershipTransferAdapterState({ options })
      const transfer = state.transfers.get(identity.bridgeId)!
      // Modeled commit; cancellation, resumed owner, custody validation and disk writes are real.
      transfer.phase = 'committed'
      transfer.destinationClaim = { generation: 1, claimId: 'claim' }
      transfer.committedSourceOutputEndSeq = 1
      transfer.commitReceipt = {
        bridgeId: identity.bridgeId,
        receiptId: 'receipt',
        acceptedSourceEndSeq: 0,
        committedAt: '2026-09-08T00:00:00.000Z'
      }
      persistRelayPtyOwnershipTransfer(state, transfer)
      const { clientId } = await source.resumeOwner()
      const generation = source.session.activeSessionOwner(clientId)!.ownerGeneration
      const pause = vi.fn()
      const resume = vi.fn()
      const ingress = new PtyOwnershipCaptureIngressFence(pause, resume)
      const handler = {
        beginOwnershipTransferCaptureIngress: (
          _id: string,
          _incarnation: string,
          authorized: () => boolean
        ) => {
          const lease = ingress.begin(authorized)
          return { ...lease, isDrained: () => lease.isCurrent() }
        }
      }
      const reopen = () =>
        newRelayPtyOwnershipTransferAdapterState({
          options: {
            ...options,
            enableSourceDeliveryRetirement: true,
            enableDestinationDelegationClaims: true,
            enableDestinationDelegationCommit: true,
            successorRetirementDependencies: { handler, publication: source.publication }
          }
        })
      state = reopen()
      const cancelOriginal = source.session.cancelDelivery.bind(source.session)
      const cancel = vi.spyOn(source.session, 'cancelDelivery').mockImplementation((...args) => {
        expect(store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
        expect(ingress.held).toBe(true)
        cancelOriginal(...args)
      })
      if (interruption === 'cancel-throw' || interruption === 'ingress-after') {
        cancel.mockImplementationOnce((...args) => {
          expect(store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
          cancelOriginal(...args)
          if (interruption === 'ingress-after') {
            ingress.observeEmission()
          } else {
            throw new Error('interrupted after cancellation')
          }
        })
      }
      if (interruption === 'ingress-before') {
        const save = store.save.bind(store)
        vi.spyOn(store, 'save').mockImplementationOnce((record) => {
          save(record)
          ingress.observeEmission()
        })
      }
      const run = async (recoveryOnly = false) => {
        let registered: MethodHandler | undefined
        registerRelayPtySuccessorRetirement(
          {
            onRequest: (method: string, callback: MethodHandler) => {
              expect(method).toBe(PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD)
              registered = callback
            }
          } as RelayDispatcher,
          state
        )
        expect(registered).toBeDefined()
        const request = {
          version: 1,
          ...identity,
          savedBaseline: baseline,
          successorGeneration: generation,
          retirementRecordSha256: 'b'.repeat(64),
          recoveryOnly
        }
        const result = await registered!(request, {
          clientId,
          isStale: () => false,
          sessionIdentity: {
            principal: 'endpoint',
            authenticated: true,
            allowSessionOwner: true,
            authenticationKind: 'endpoint-credential'
          }
        })
        return parsePtyOwnershipTransferSuccessorRetirementResult(result, request)
      }
      if (interrupted) {
        await expect(run()).rejects.toThrow(
          interruption === 'cancel-throw' ? 'interrupted after cancellation' : 'ingress_unavailable'
        )
        expect(ingress.held).toBe(false)
        if (interruption === 'ingress-before') {
          expect(cancel).not.toHaveBeenCalled()
        }
        expect(source.publication.accepts('source')).toBe(true)
        expect(store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
        state = reopen()
      }
      const result = await run(interrupted)
      expect(result.sourceCancellation).toEqual({
        canceled: true,
        sentEndSu: 256,
        creditedEndSu: 0
      })
      expect(store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('retired')
      expect(source.session.sourceDeliverySnapshotIfKnown(actual)).toEqual({
        ...actual,
        state: 'closed'
      })
      expect(source.publication.accepts('source')).toBe(false)
      expect(source.publication.accepts('other')).toBe(true)
      expect(ingress.held).toBe(false)
      const calls = cancel.mock.calls.length
      state = reopen()
      expect(await run(true)).toEqual(result)
      expect(cancel).toHaveBeenCalledTimes(calls)
      expect(pause.mock.calls.length).toBe(resume.mock.calls.length)
    } finally {
      vi.restoreAllMocks()
      source.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
