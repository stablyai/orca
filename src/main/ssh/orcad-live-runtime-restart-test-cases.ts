import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { testState } from '../persistence-test-harness'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'
import { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'
import { restoreOutgoingOrcadPreparationAdmission } from './orcad-outgoing-preparation-startup'
import { OrcadLiveRuntimeCleanupCheckpointStore } from './orcad-live-runtime-cleanup-checkpoint'
import { targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { createWaitBlockedCheckState } from '../runtime/wait-blocked-check-state'
import { retireOrcadLiveSourceDeliveries } from './orcad-live-source-delivery-retirement'
import {
  createOrcadLiveSourceCancellationReceipt,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'
import * as secureFile from '../../shared/secure-file'
import * as remoteRetirement from './orcad-captured-source-retirement-client'
import { seedLiveRetirementCaptures } from './orcad-live-retirement-capture-test-fixture'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
import { registerLiveRestartClaimTests } from './orcad-live-restart-claim-test-cases'
import { registerLiveRetirementCrashTests } from './orcad-live-retirement-crash-test-cases'

class RestartRuntime extends OrcaRuntimeService {
  addSourceResidue(id: string, kind: 'output' | 'title' | 'wait' = 'output') {
    if (kind === 'title') {
      this.getOrCreatePtyTitleTrackerEntry(id)
    } else if (kind === 'wait') {
      this.waitBlockedCheckStateByPtyId.set(id, createWaitBlockedCheckState())
    } else {
      this.ptyOutputSequenceById.set(id, 1)
    }
  }
}

export function registerLiveRuntimeRestartTests(fixture: typeof controlReleaseFixture) {
  const prepare = async (saveOutput = true, restoreAdmission = true) => {
    const f = await fixture()
    const released = await f.release()
    if (saveOutput) {
      new OrcadLiveCleanupOutputEvidenceStore(testState.dir).persist(
        createOrcadLiveCleanupOutputEvidence(f.record, released.sourceOutputSettlements)
      )
    }
    f.output.uninstall()
    const sourceIdentity = vi
      .spyOn(f.provider, 'getOwnershipTransferSourceIdentity')
      .mockClear()
      .mockImplementation(() => {
        throw new Error('old source provider unavailable')
      })
    const runtime = new RestartRuntime()
    if (restoreAdmission) {
      await restoreOutgoingOrcadPreparationAdmission(
        f.target.id,
        {
          fencePtyControlsAndDrain: vi.fn(async () => {}),
          fencePtyPreparationSurface: vi.fn(),
          fencePtyCatalogCreation: vi.fn()
        },
        testState.dir,
        runtime
      )
    }
    const options = {
      profileDirectory: testState.dir,
      store: f.store,
      migrationId: f.cutover.manifest.migrationId,
      runtime,
      remote: f.remote,
      activate: f.activate,
      signal: new AbortController().signal
    }
    const run = (operation: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[1]) =>
      withOrcadLiveRuntimeRestartReadiness(options, operation)
    return { ...f, runtime, sourceIdentity, run, options, released }
  }

  const prepareCompleted = async () => {
    const f = await prepare()
    const receipts = new OrcadLiveSourceCancellationReceiptStore(testState.dir)
    for (const { identity } of f.cutover.liveTerminalBindings!) {
      const settled = f.released.sourceOutputSettlements.find(
        (entry) => entry.id === identity.terminalId
      )!
      const end = settled.throughSourceEndSu
      receipts.persist(
        createOrcadLiveSourceCancellationReceipt({
          record: f.record,
          settlements: f.released.sourceOutputSettlements,
          retirement: {
            ...identity,
            version: 1,
            sourceDeliveryRetirement: {
              phase: 'retired',
              retirementRecordSha256: f.record.sha256,
              delivery: {
                id: identity.terminalId,
                ptyIncarnation: identity.incarnationId,
                providerGeneration: 77,
                clientGeneration: settled.clientGeneration,
                ownerGeneration: settled.ownerGeneration,
                deliveryToken: settled.deliveryToken,
                state: 'active',
                windowSu: 256,
                receivedEndSu: end,
                sentEndSu: end,
                creditedEndSu: end,
                generationClosed: false,
                exitPublished: false
              }
            }
          },
          cancellation: { canceled: true, sentEndSu: end, creditedEndSu: end }
        })
      )
    }
    return { ...f, receipts }
  }

  it.each([false, true])(
    'joins real capture/profile receipt persistence with recoveryOnly=%s',
    async (recoveryOnly) => {
      const f = await prepare()
      const options = { ...f.options, recoveryOnly }
      if (recoveryOnly) {
        vi.spyOn(f.provider, 'isOutgoingSourceControlReleased').mockImplementation(() => {
          throw new Error('original provider unavailable')
        })
      }
      seedLiveRetirementCaptures(testState.dir, f)
      const order: string[] = []
      const remote = vi
        .spyOn(remoteRetirement, 'retireRemoteOrcadCapturedSourceDelivery')
        .mockImplementation(async ({ request, assertAuthority }) => {
          assertAuthority()
          expect(targetLifecycleInFlight.has(f.target.id)).toBe(true)
          expect(request.recoveryOnly === true).toBe(recoveryOnly)
          order.push('retire')
          return parsePtyOwnershipTransferSourceRetirementEvidence({
            ...(request.identity as object),
            version: 1,
            ...(recoveryOnly
              ? { sourceCancellation: { canceled: true, sentEndSu: 4, creditedEndSu: 4 } }
              : {}),
            sourceDeliveryRetirement: {
              phase: 'retired',
              retirementRecordSha256: request.retirementRecordSha256,
              delivery: request.expectedDelivery
            }
          })
        })
      f.mux.request.mockImplementation(async (...args: unknown[]) => {
        expect(args[0]).toBe('pty.cancelDelivery')
        expect(targetLifecycleInFlight.has(f.target.id)).toBe(true)
        order.push('cancel')
        return { canceled: true, sentEndSu: 4, creditedEndSu: 4 }
      })
      const result = await retireOrcadLiveSourceDeliveries(options)
      expect(order).toEqual(
        recoveryOnly ? ['retire', 'retire'] : ['retire', 'cancel', 'retire', 'cancel']
      )
      expect(result.receipts).toHaveLength(2)
      expect(new OrcadLiveSourceCancellationReceiptStore(testState.dir).list()).toEqual(
        expect.arrayContaining(result.receipts)
      )
      expect(f.sourceIdentity).not.toHaveBeenCalled()
      remote.mockClear()
      f.mux.request.mockClear()
      await expect(retireOrcadLiveSourceDeliveries(options)).resolves.toEqual(result)
      expect(remote).not.toHaveBeenCalled()
      expect(f.mux.request).not.toHaveBeenCalled()
    }
  )

  it('recovers seeded durable delivery receipts under actual profile locks and runtime absence', async () => {
    const f = await prepareCompleted()
    const before = f.receipts.list()
    const write = vi.spyOn(secureFile, 'writeDurableSecureJsonFile')
    const result = await retireOrcadLiveSourceDeliveries(f.options)
    expect(result.phase).toBe('source-deliveries-retired')
    expect(result.receipts).toHaveLength(2)
    expect(result.receipts).toEqual(expect.arrayContaining(before))
    expect(f.receipts.list()).toEqual(before)
    expect(
      write.mock.calls.filter(([path]) => path.includes('orcad-live-source-cancellation-receipts'))
    ).toHaveLength(2)
    expect(f.sourceIdentity).not.toHaveBeenCalled()
    expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
    expect(new OrcadLiveRuntimeCleanupCheckpointStore(testState.dir).list()).toEqual([])
  })

  it('rejects uncertain receipt reflush without source reconnection or cleanup completion', async () => {
    const f = await prepareCompleted()
    const original = secureFile.writeDurableSecureJsonFile
    vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementation((path, value) => {
      if (path.includes('orcad-live-source-cancellation-receipts')) {
        return false
      }
      return original(path, value)
    })
    await expect(retireOrcadLiveSourceDeliveries(f.options)).rejects.toThrow(
      'permissions_unconfirmed'
    )
    expect(f.receipts.list()).toHaveLength(2)
    expect(f.sourceIdentity).not.toHaveBeenCalled()
    expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
  })

  it('does not let complete receipts bypass source runtime residue checks', async () => {
    const f = await prepareCompleted()
    f.runtime.addSourceResidue(
      toAppSshPtyId(f.target.id, f.cutover.liveTerminalBindings![0].identity.terminalId)
    )
    const persist = vi.spyOn(OrcadLiveSourceCancellationReceiptStore.prototype, 'persist')
    await expect(retireOrcadLiveSourceDeliveries(f.options)).rejects.toThrow('surfaces_present')
    expect(persist).not.toHaveBeenCalled()
    expect(f.sourceIdentity).not.toHaveBeenCalled()
  })

  it('holds fresh restart readiness without old intake/provider state or synthesizing cleanup completion', async () => {
    const f = await prepare()
    let held: (() => void) | undefined
    const result = await f.run(async ({ record, outputEvidence, assertCurrent }) => {
      held = assertCurrent
      expect(targetLifecycleInFlight.has(f.target.id)).toBe(true)
      expect(record).toEqual(f.record)
      expect(outputEvidence.settlements).toHaveLength(2)
      await Promise.resolve()
      assertCurrent()
      return 'ready'
    })
    expect(result).toBe('ready')
    expect(() => held!()).toThrow('authority_released')
    expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
    expect(f.sourceIdentity).not.toHaveBeenCalled()
    expect(new OrcadLiveRuntimeCleanupCheckpointStore(testState.dir).list()).toEqual([])
  })

  it.each(['output', 'admission'] as const)(
    'refuses restart readiness without %s evidence',
    async (missing) => {
      const f = await prepare(missing !== 'output', missing !== 'admission')
      const callback = vi.fn(async () => {})
      await expect(f.run(callback)).rejects.toThrow(
        missing === 'output' ? 'evidence_required' : 'admission_unfenced'
      )
      expect(callback).not.toHaveBeenCalled()
    }
  )

  it.each(['output', 'title', 'wait'] as const)(
    'refuses source %s drift during fresh destination activation',
    async (kind) => {
      const f = await prepare()
      const activate = f.activate.getMockImplementation()!
      f.activate.mockImplementationOnce(async (...args) => {
        const result = await activate(...args)
        f.runtime.addSourceResidue(
          toAppSshPtyId(f.target.id, f.cutover.liveTerminalBindings![0].identity.terminalId),
          kind
        )
        return result
      })
      const callback = vi.fn(async () => {})
      await expect(f.run(callback)).rejects.toThrow('surfaces_present')
      expect(callback).not.toHaveBeenCalled()
    }
  )

  it('recovers completed receipts under newer destination claims without rewriting history', async () => {
    const f = await prepareCompleted()
    const activate = f.activate.getMockImplementation()!
    const historical = structuredClone(f.record)
    f.activate.mockImplementation(async (...args) => ({
      ...(await activate(...args)),
      destinationClaim: { generation: 2, claimId: 'replacement' }
    }))
    await f.run(async ({ record, activations }) => {
      expect(record).toEqual(historical)
      expect(activations.map((entry) => entry.destinationClaim)).toEqual([
        { generation: 2, claimId: 'replacement' },
        { generation: 2, claimId: 'replacement' }
      ])
    })
    await expect(retireOrcadLiveSourceDeliveries(f.options)).resolves.toMatchObject({
      phase: 'source-deliveries-retired'
    })
    expect(f.sourceIdentity).not.toHaveBeenCalled()
    expect(f.receipts.list()).toHaveLength(2)
    expect(f.record).toEqual(historical)
  })

  registerLiveRestartClaimTests(prepare)
  registerLiveRetirementCrashTests(prepare)

  it('rejects lost durable output evidence during restart work and invalidates escaped authority', async () => {
    const f = await prepare()
    let held: (() => void) | undefined
    await expect(
      f.run(async ({ assertCurrent }) => {
        held = assertCurrent
        vi.spyOn(OrcadLiveCleanupOutputEvidenceStore.prototype, 'read').mockReturnValue(null)
      })
    ).rejects.toThrow('evidence_changed')
    expect(() => held!()).toThrow('authority_released')
  })
}
