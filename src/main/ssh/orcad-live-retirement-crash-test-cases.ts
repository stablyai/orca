import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { testState } from '../persistence-test-harness'
import * as secureFile from '../../shared/secure-file'
import * as remoteRetirement from './orcad-captured-source-retirement-client'
import { retireOrcadLiveSourceDeliveries } from './orcad-live-source-delivery-retirement'
import { seedLiveRetirementCaptures } from './orcad-live-retirement-capture-test-fixture'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
import { reflushOrcadLiveRuntimeCleanupCheckpoint } from './orcad-live-runtime-cleanup-resume'
import {
  createOrcadLiveRuntimeCleanupCheckpoint,
  OrcadLiveRuntimeCleanupCheckpointStore
} from './orcad-live-runtime-cleanup-checkpoint'

type SourceFixture = Awaited<ReturnType<typeof controlReleaseFixture>>
type Fixture = Pick<SourceFixture, 'provider' | 'mux' | 'cutover' | 'target' | 'record'> & {
  released: Awaited<ReturnType<SourceFixture['release']>>
  options: Parameters<typeof retireOrcadLiveSourceDeliveries>[0]
}

export function registerLiveRetirementCrashTests(prepare: () => Promise<Fixture>) {
  it.each(['missing', 'durable', 'write-failed'] as const)(
    'reacknowledges existing cleanup only under fresh authority: %s',
    async (mode) => {
      const f = await prepare()
      const checkpoints = new OrcadLiveRuntimeCleanupCheckpointStore(testState.dir)
      const expected = createOrcadLiveRuntimeCleanupCheckpoint(f.record)
      if (mode !== 'missing') {
        checkpoints.persist(expected)
      }
      const persist = vi.spyOn(OrcadLiveRuntimeCleanupCheckpointStore.prototype, 'persist')
      if (mode === 'write-failed') {
        persist.mockImplementation(() => {
          throw new Error('checkpoint reflush failed')
        })
      }
      const result = reflushOrcadLiveRuntimeCleanupCheckpoint(f.options)
      await (mode === 'durable'
        ? expect(result).resolves.toEqual(expected)
        : expect(result).rejects.toThrow(
            mode === 'missing' ? 'checkpoint_required' : 'reflush failed'
          ))
      expect(persist).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1)
    }
  )

  it.each(['before', 'after'] as const)(
    'recovers a partial cohort after uncertain second receipt write %s persistence',
    async (when) => {
      const f = await prepare()
      seedLiveRetirementCaptures(testState.dir, f)
      const hostRetired = new Set<string>()
      const remote = vi
        .spyOn(remoteRetirement, 'retireRemoteOrcadCapturedSourceDelivery')
        .mockImplementation(async ({ request, assertAuthority }) => {
          assertAuthority()
          const identity = request.identity as { terminalId: string }
          if (request.recoveryOnly) {
            expect(hostRetired.has(identity.terminalId)).toBe(true)
          } else {
            hostRetired.add(identity.terminalId)
          }
          return parsePtyOwnershipTransferSourceRetirementEvidence({
            ...(request.identity as object),
            version: 1,
            ...(request.recoveryOnly
              ? { sourceCancellation: { canceled: true, sentEndSu: 4, creditedEndSu: 4 } }
              : {}),
            sourceDeliveryRetirement: {
              phase: 'retired',
              retirementRecordSha256: request.retirementRecordSha256,
              delivery: request.expectedDelivery
            }
          })
        })
      f.mux.request.mockResolvedValue({ canceled: true, sentEndSu: 4, creditedEndSu: 4 })
      const original = secureFile.writeDurableSecureJsonFile
      let writes = 0
      const write = vi
        .spyOn(secureFile, 'writeDurableSecureJsonFile')
        .mockImplementation((path, value) => {
          if (path.includes('orcad-live-source-cancellation-receipts') && ++writes === 2) {
            if (when === 'after') {
              original(path, value)
            }
            return false
          }
          return original(path, value)
        })
      await expect(retireOrcadLiveSourceDeliveries(f.options)).rejects.toThrow(
        'permissions_unconfirmed'
      )
      expect(hostRetired.size).toBe(2)
      expect(new OrcadLiveSourceCancellationReceiptStore(testState.dir).list()).toHaveLength(
        when === 'before' ? 1 : 2
      )
      write.mockRestore()
      remote.mockClear()
      f.mux.request.mockClear()
      vi.spyOn(f.provider, 'isOutgoingSourceControlReleased').mockImplementation(() => {
        throw new Error('original provider gone')
      })
      const recovered = await retireOrcadLiveSourceDeliveries({ ...f.options, recoveryOnly: true })
      expect(recovered.receipts).toHaveLength(2)
      expect(remote).toHaveBeenCalledTimes(when === 'before' ? 1 : 0)
      expect(f.mux.request).not.toHaveBeenCalled()
      expect(new OrcadLiveSourceCancellationReceiptStore(testState.dir).list()).toEqual(
        expect.arrayContaining(recovered.receipts)
      )
      remote.mockClear()
      await expect(
        retireOrcadLiveSourceDeliveries({ ...f.options, recoveryOnly: true })
      ).resolves.toEqual(recovered)
      expect(remote).not.toHaveBeenCalled()
    }
  )
}
