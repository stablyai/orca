import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation,
  context
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { beginRelayPtySuccessorCaptureBoundary } from './relay-pty-successor-capture-boundary'
import { beginRelayPtySuccessorRetentionEvidence } from './relay-pty-successor-retention-evidence'

it.each([true, false])(
  'reconciles transformed raw delivery after owner replacement (acknowledged: %s)',
  async (acknowledged) => {
    const source = await createSourceRetirementPublicationFixture()
    const directory = mkdtempSync(join(tmpdir(), 'orca-successor-composed-'))
    const release = vi.fn()
    try {
      const identity = { ...source.source, bridgeId: 'bridge', destinationRuntimeId: 'destination' }
      const store = new RelayPtyOwnershipTransferFileStore(directory)
      const transfer = makeDelegatedRelay(store, {
        enableDestinationOutputRetention: true,
        resolveSource: (id) => source.publication.ownershipTransfer.resolve(id),
        resolveTerminalIncarnation: () => identity.incarnationId,
        hasPendingSourceOutput: () => false
      })
      transfer.prepare({
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
      transfer.observeOutput('source', 'start', '100:105', undefined, {
        emissionId: '100:105',
        rawStartSu: 100,
        rawEndSu: 105,
        displayStartSu: 0,
        displayEndSu: 5,
        displayLengthSu: 5
      })
      source.publication.publish('source', { data: 'start' }, false)
      await source.acknowledge('source', 5)
      const baseline = parsePtyOwnershipCaptureBaseline(
        {
          version: 1,
          modelSha256: 'a'.repeat(64),
          boundary: { version: 1, identity, throughSeq: 1, delivery: source.prepare().delivery }
        },
        identity
      )
      transfer.retainCaptureBoundary(identity, baseline.boundary)
      transfer.selectCaptureBaseline(identity, baseline, () => baseline.boundary)
      transfer.observeOutput('source', 'one🙂', '105:127', undefined, {
        emissionId: '105:127',
        rawStartSu: 105,
        rawEndSu: 127,
        displayStartSu: 0,
        displayEndSu: 5,
        displayLengthSu: 5
      })
      source.publication.publish(
        'source',
        { data: 'one🙂', rawLength: 22, transformed: true },
        false
      )
      if (acknowledged) {
        await source.acknowledge('source', 27)
      }
      const cancel = vi.spyOn(source.session, 'cancelDelivery')
      const { clientId } = await source.resumeOwner()
      expect(transfer.inspectPreparedCaptureCursor(identity)).toBeNull()
      const begin = acknowledged
        ? beginRelayPtySuccessorCaptureBoundary
        : beginRelayPtySuccessorRetentionEvidence
      const capture = begin(
        identity,
        baseline,
        source.source.sourceOwnerGeneration + 1,
        context(clientId),
        {
          transfer,
          source: source.publication.ownershipTransfer,
          handler: {
            beginOwnershipTransferCaptureIngress: () => ({
              isCurrent: () => true,
              isDrained: () => true,
              release
            })
          }
        }
      )
      expect(capture.inspect()).toMatchObject({
        ...(acknowledged ? { throughSeq: 2 } : { journalThroughSeq: 2, coveredReceivedEndSu: 27 }),
        delivery: { receivedEndSu: 27, sentEndSu: 27, creditedEndSu: acknowledged ? 27 : 5 }
      })
      expect(store.loadAll()[0].captureBaseline).toEqual(baseline)
      expect(cancel).not.toHaveBeenCalled()
      capture.release()
      expect(release).toHaveBeenCalledOnce()
    } finally {
      source.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
