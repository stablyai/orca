import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { createOrcadModelImportSocketFixture } from './orcad-model-import-socket-fixture'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { prepareRemoteOrcadCapturedDestination } from '../ssh/orcad-captured-destination-client'
import { commitRemoteOrcadMigrationCatalog } from '../ssh/orcad-migration-catalog-client'
import { inspectRemoteOrcadCatalogActivation } from '../ssh/orcad-catalog-activation-client'
import { inspectRemoteOrcadCatalogOutputCoverage } from '../ssh/orcad-catalog-output-coverage-client'
import { retireRemoteOrcadCapturedSourceDelivery } from '../ssh/orcad-captured-source-retirement-client'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import {
  identity,
  preparation,
  request,
  context
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const lifetimes: OrcadRuntimeLifetime[] = []
let server: OrcaRuntimeRpcServer | undefined
let source: Awaited<ReturnType<typeof createOrcadModelImportSocketFixture>> | undefined
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'oc-cat-sock-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
})
afterEach(async () => {
  await server?.stop()
  server = undefined
  for (const lifetime of lifetimes.splice(0)) {
    await lifetime.stop()
  }
  await source?.close()
  source = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function destination() {
  const store = createStore()
  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId: identity.destinationRuntimeId,
    ptyOwnershipTransferMutationEnabled: () => true
  })
  expect(
    runtime.installPtyOwnershipTransferDestinationOutputBridge({ catalogPublicationVersion: 1 })
  ).toBe(true)
  const lifetime = new OrcadRuntimeLifetime(() => {})
  lifetimes.push(lifetime)
  const errors = vi.fn()
  const lifecycle = installOrcadDelegatedRecovery({
    enabled: true,
    registry: runtime.getPtyOwnershipTransferDestinationRegistry(),
    lifetime,
    onError: errors,
    initializeModel: async (identity, signal) => {
      runtime.registerPublishedDelegatedPty(identity)
      await runtime.initializeDelegatedPtyOwnershipModel(identity, signal)
    },
    prepareModelFrame: (identity, frame, signal) =>
      runtime.prepareDelegatedPtyModelFrame(identity, frame, signal)
  })!
  lifetime.add(runtime.installCapturedPtyDestinationLifecycle(lifecycle))
  return { store, runtime, lifetime, lifecycle, errors }
}

it('preserves encrypted catalog publication across destination recreation and real source-socket reconnect', async () => {
  const suffix = 'm after capture\r\n'
  let deliveryRemoved = false
  const delivery = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'original-source',
    state: 'active' as const,
    windowSu: 1024,
    receivedEndSu: 5,
    sentEndSu: 5,
    creditedEndSu: 5,
    generationClosed: false,
    exitPublished: false
  }
  const removeDelivery = vi.fn((assertAuthority: () => void) => {
    assertAuthority()
    deliveryRemoved = true
  })
  const prepareRetirement = vi.fn(() => ({
    delivery,
    assertCurrent: () => {},
    remove: removeDelivery,
    assertRemoved: () => {
      if (!deliveryRemoved) {
        throw new Error('source delivery still present')
      }
    }
  }))
  source = await createOrcadModelImportSocketFixture(testState.dir, {
    laterOutput: suffix,
    sourceOptions: {
      enableDestinationOutputRoutes: true,
      enableDestinationDelegationCommit: true,
      resolveTerminalIncarnation: () => identity.incarnationId,
      hasPendingSourceOutput: () => false,
      enableSourceDeliveryRetirement: true,
      prepareSourceDeliveryRetirement: prepareRetirement
    }
  })
  const first = destination()
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  first.store.stageOrcadMigrationCatalog(manifest)
  await first.store.flushPendingOrThrowAsync()
  const surfaceBinding = preparation.surfacePublication.surfaceBinding
  const catalogAdmission = parseOrcadTerminalLayoutAdmission({
    version: 1,
    manifest,
    bindings: [{ identity, surfaceBinding }]
  })
  mkdirSync(join(testState.dir, 'rpc'))
  server = new OrcaRuntimeRpcServer({
    runtime: first.runtime,
    userDataPath: join(testState.dir, 'rpc'),
    enableWebSocket: true,
    pinnedBindHost: '127.0.0.1',
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'catalog-recovery',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  const published = await prepareRemoteOrcadCapturedDestination({
    pairingCode: offer.pairingUrl,
    runtimeId: identity.destinationRuntimeId,
    surfaceBinding,
    capture: {
      identity,
      source: source.store.loadDelegatedSource(identity)!,
      model: source.model,
      signal: source.controller.signal,
      catalogAdmission
    }
  })
  expect(published.outcome).toBe('published')
  expect(source.source.inspectDestination(request(), context()).phase).toBe('committed')
  await expect(
    commitRemoteOrcadMigrationCatalog(offer.pairingUrl, manifest, {
      expectedRuntimeId: identity.destinationRuntimeId
    })
  ).resolves.toMatchObject({ state: 'committed' })
  await vi.waitFor(async () => {
    const model = await first.runtime.serializePublishedDelegatedPtyModel(identity)
    expect(model?.data).toContain('after capture')
    expect(model?.seq).toBe(source!.model.modelSequenceEnd + suffix.length)
  })
  expect(first.errors.mock.calls).toEqual([])
  const remoteActivation = await inspectRemoteOrcadCatalogActivation({
    pairingCode: offer.pairingUrl,
    request: { identity, catalogAdmission, publicationReceipt: published.publicationReceipt },
    signal: source.controller.signal
  })
  expect(remoteActivation.catalog).toEqual({
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256
  })
  expect(remoteActivation.publicationReceipt).toEqual(published.publicationReceipt)
  await vi.waitFor(async () => {
    const applied = await inspectRemoteOrcadCatalogOutputCoverage({
      pairingCode: offer.pairingUrl,
      request: {
        identity,
        catalogAdmission,
        publicationReceipt: published.publicationReceipt,
        throughSeq: source!.model.throughSeq + 1
      },
      signal: source!.controller.signal
    })
    expect(applied.coverage.throughSeq).toBe(source!.model.throughSeq + 1)
    expect(applied.coverage.modelSequenceEnd).toBe(source!.model.modelSequenceEnd + suffix.length)
    expect(applied.destinationClaim).toEqual(remoteActivation.destinationClaim)
  })
  const retire = (expectedDelivery = delivery, recoveryOnly = false) =>
    retireRemoteOrcadCapturedSourceDelivery({
      pairingCode: offer.pairingUrl,
      signal: source!.controller.signal,
      assertAuthority: () => {},
      request: {
        identity,
        catalogAdmission,
        publicationReceipt: published.publicationReceipt,
        retirementRecordSha256: 'a'.repeat(64),
        expectedDelivery,
        ...(recoveryOnly ? { recoveryOnly: true } : {})
      }
    })
  await expect(
    retire({ ...delivery, receivedEndSu: 6, sentEndSu: 6, creditedEndSu: 6 })
  ).rejects.toThrow()
  expect(removeDelivery).not.toHaveBeenCalled()
  expect(source.sourceStore.loadAll()[0].sourceDeliveryRetirement).toBeUndefined()
  await expect(retire(delivery, true)).rejects.toThrow('retirement_failed:runtime_error')
  expect(removeDelivery).not.toHaveBeenCalled()
  expect(source.sourceStore.loadAll()[0].sourceDeliveryRetirement).toBeUndefined()
  const retired = await retire()
  expect(retired.sourceDeliveryRetirement).toEqual({
    phase: 'retired',
    retirementRecordSha256: 'a'.repeat(64),
    delivery
  })
  expect(await retire()).toEqual(retired)
  expect(await retire(delivery, true)).toEqual({
    ...retired,
    sourceCancellation: {
      canceled: true,
      sentEndSu: delivery.sentEndSu,
      creditedEndSu: delivery.creditedEndSu
    }
  })
  expect(removeDelivery).toHaveBeenCalledOnce()
  expect(source.sourceStore.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('retired')
  expect(first.lifecycle.supervisor.getConnection(identity)?.isActive()).toBe(true)
  const activation = await first.runtime.inspectCapturedPtyDestinationActivation(
    identity,
    source.controller.signal
  )
  expect(activation.publicationReceipt).toEqual(published.publicationReceipt)
  const connection = first.lifecycle.supervisor.getConnection(identity)!
  const status = connection.client.status.bind(connection.client)
  const stale = vi.spyOn(connection.client, 'status').mockImplementationOnce(async (...args) => {
    const result = await status(...args)
    return {
      ...result,
      destinationClaim: {
        ...activation.destinationClaim,
        generation: activation.destinationClaim.generation + 1
      }
    }
  })
  await expect(
    first.lifecycle.inspectPublishedDestinationActivation(identity, source.controller.signal)
  ).rejects.toThrow('activation_unverifiable')
  stale.mockRestore()
  const mismatched = vi
    .spyOn(connection.client, 'status')
    .mockImplementationOnce(async (...args) => {
      const result = await status(...args)
      return {
        ...result,
        receipt: result.receipt ? { ...result.receipt, receiptId: 'different-commit' } : undefined
      }
    })
  await expect(
    first.runtime.inspectCapturedPtyDestinationActivation(identity, source.controller.signal)
  ).rejects.toThrow('activation_unverifiable')
  mismatched.mockRestore()
  await expect(
    first.runtime.inspectCapturedPtyDestinationActivation(
      { ...identity, destinationRuntimeId: 'another-runtime' },
      source.controller.signal
    )
  ).rejects.toThrow('captured_activation_unavailable')
  await server.stop()
  server = undefined
  await first.lifetime.stop()
  await expect(
    first.lifecycle.inspectPublishedDestinationActivation(identity, source.controller.signal)
  ).rejects.toThrow()
  await source.reopenSource()

  const restored = destination()
  await restored.lifecycle.settleInitialRecovery()
  expect(restored.store.getOrcadMigrationCatalogState(manifest).state).toBe('committed')
  expect(restored.lifecycle.supervisor.getConnection(identity)?.isActive()).toBe(true)
  const recoveredActivation = await restored.runtime.inspectCapturedPtyDestinationActivation(
    identity,
    source.controller.signal
  )
  expect(recoveredActivation.publicationReceipt).toEqual(activation.publicationReceipt)
  expect(recoveredActivation.destinationClaim.generation).toBeGreaterThan(
    activation.destinationClaim.generation
  )
  const reclaimedRetirement = await restored.lifecycle.retirePublishedSourceDelivery({
    identity,
    retirementRecordSha256: 'a'.repeat(64),
    expectedDelivery: delivery,
    signal: source.controller.signal,
    assertAuthority: () => {}
  })
  expect(reclaimedRetirement).toEqual(retired)
  expect(removeDelivery).toHaveBeenCalledOnce()
  const model = await restored.runtime.serializePublishedDelegatedPtyModel(identity)
  expect(model?.data.match(/after capture/g)).toHaveLength(1)
  expect(model?.seq).toBe(source.model.modelSequenceEnd + suffix.length)
  const continuation = 'after reconnect\r\n'
  source.source.observeOutput(identity.terminalId, continuation)
  await vi.waitFor(async () => {
    const current = await restored.runtime.serializePublishedDelegatedPtyModel(identity)
    expect(current?.data.match(/after capture/g)).toHaveLength(1)
    expect(current?.data.match(/after reconnect/g)).toHaveLength(1)
    expect(current?.seq).toBe(source!.model.modelSequenceEnd + suffix.length + continuation.length)
  })
  expect(restored.errors.mock.calls).toEqual([])
  expect(source.accepted.mock.calls.length).toBeGreaterThanOrEqual(3)
})
