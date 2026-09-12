import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, dataFile, testState } from '../persistence-test-harness'
import { terminalScrollbackStoredBytesEqualSync } from '../terminal-scrollback-durable-artifact'
import { getProfileTerminalScrollbackSnapshotRoot } from '../terminal-scrollback-snapshots'
import {
  ownershipTransferSurfaceModelSnapshotRef,
  ownershipTransferSurfaceSnapshotRef
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-snapshot-reference'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import { installCatalogSupervisorTestTransport } from './orcad-catalog-supervisor-test-transport'
import { installOrcadDelegatedRecovery } from './orcad-delegated-recovery-lifecycle'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { prepareRemoteOrcadCapturedDestination } from '../ssh/orcad-captured-destination-client'
import { OrcadOutgoingCaptureStore } from '../ssh/orcad-outgoing-capture-store'
import { publishOutgoingOrcadCapture } from '../ssh/orcad-outgoing-capture-publication'
import {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState
} from '../ssh/orcad-migration-catalog-client'
import { resolveDurableOrcadCatalogMutation } from '../ssh/orcad-catalog-durable-mutation'
import { liveDesktopProfileFixture } from './orcad-live-desktop-profile-test-fixture'
import { withOrcadLiveSourceCutover } from '../ssh/orcad-live-source-cutover'
import { resumeOrcadLiveDestination } from '../ssh/orcad-live-destination-coordinator'
import { inspectOrcadLiveSourceReleaseReadiness } from '../ssh/orcad-live-destination-activation'
import { OrcadOutgoingPreparationStore } from '../ssh/orcad-outgoing-preparation-store'
import { parsePairingCode } from '../../shared/pairing'
import { Store } from '../persistence'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { capturedPreparationFixture } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-captured-preparation-test-fixture'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { readCapturedPtyPublicationRetry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-captured-publication-retry'
import {
  context,
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./orcad-local-relay-connection', () => ({ connectOrcadLocalRelay: vi.fn() }))
const desktop = vi.hoisted(() => ({
  target: vi.fn(),
  store: vi.fn(),
  environment: vi.fn(),
  provider: vi.fn()
}))
// This suite isolates encrypted catalog phases; the live start suite exercises peer readiness.
vi.mock('../ssh/orcad-live-migration-preflight', () => ({
  assertOrcadLiveMigrationPreflight: vi.fn()
}))
vi.mock('../ssh/orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({
    getTarget: desktop.target,
    getOrcadMigrationStore: desktop.store
  })
}))
vi.mock('../ssh/orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: async () => {} }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: desktop.environment
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: desktop.provider,
  getProviderForPty: desktop.provider
}))

let server: OrcaRuntimeRpcServer | undefined
const lifetimes: OrcadRuntimeLifetime[] = []
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-catalog-rpc-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
})
afterEach(async () => {
  await server?.stop()
  await Promise.all(lifetimes.splice(0).map((lifetime) => lifetime.stop()))
  server = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(connectOrcadLocalRelay).mockReset()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function setup(enabled: boolean, stage = true, productionSupervisor = false) {
  const f = capturedPreparationFixture(productionSupervisor)
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const surfaceBinding = preparation.surfacePublication.surfaceBinding
  const catalogAdmission = parseOrcadTerminalLayoutAdmission({
    version: 1,
    manifest,
    bindings: [{ identity, surfaceBinding }]
  })
  if (stage) {
    f.store.stageOrcadMigrationCatalog(manifest)
    f.store.flushOrThrow()
  }
  let registry = f.reopen(f.store, enabled ? 1 : undefined)
  const runtime = new OrcaRuntimeService(f.store, undefined, {
    runtimeId: identity.destinationRuntimeId,
    ptyOwnershipTransferMutationEnabled: () => true
  })
  if (productionSupervisor) {
    expect(
      runtime.installPtyOwnershipTransferDestinationOutputBridge({ catalogPublicationVersion: 1 })
    ).toBe(true)
    registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
  }
  const removeTestLifecycle = runtime.installCapturedPtyDestinationLifecycle({
    supportsCapturedCatalogPublication: () => registry.supportsCapturedCatalogPublication(),
    prepareCapturedDestination: (capture) =>
      registry.get(identity.bridgeId)?.snapshot().phase === 'published'
        ? Promise.resolve(
            readCapturedPtyPublicationRetry(
              capture,
              registry.getPublishedDelegatedDestination(identity)
            )
          )
        : registry.prepareCapturedDelegated(capture)
  })
  const errors = vi.fn()
  let lifecycle: ReturnType<typeof installOrcadDelegatedRecovery> = null
  if (productionSupervisor) {
    removeTestLifecycle()
    installCatalogSupervisorTestTransport(f.source)
    const lifetime = new OrcadRuntimeLifetime(() => {})
    lifetimes.push(lifetime)
    lifecycle = installOrcadDelegatedRecovery({
      enabled: true,
      registry,
      lifetime,
      onError: errors,
      initializeModel: async (identity, signal) => {
        runtime.registerPublishedDelegatedPty(identity)
        await runtime.initializeDelegatedPtyOwnershipModel(identity, signal)
      },
      prepareModelFrame: (identity, frame, signal) =>
        runtime.prepareDelegatedPtyModelFrame(identity, frame, signal)
    })
    runtime.installCapturedPtyDestinationLifecycle(lifecycle!)
  }
  mkdirSync(join(testState.dir, 'rpc'))
  server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: join(testState.dir, 'rpc'),
    enableWebSocket: true,
    pinnedBindHost: '127.0.0.1',
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'catalog-client',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('Runtime pairing unavailable')
  }
  return {
    ...f,
    lifecycle,
    errors,
    runtime,
    manifest,
    catalogAdmission,
    options: {
      pairingCode: offer.pairingUrl,
      runtimeId: identity.destinationRuntimeId,
      surfaceBinding,
      capture: { ...f.input, catalogAdmission }
    },
    reload: () => {
      const restored = createStore()
      registry = f.reopen(restored, enabled ? 1 : undefined)
      registry.recoverPersistedDelegatedDestinations()
      return restored
    }
  }
}

it('keeps catalog publication default-off and refuses to replace an installed registry', () => {
  const runtime = new OrcaRuntimeService(createStore(), undefined, {
    runtimeId: identity.destinationRuntimeId
  })
  expect(runtime.installPtyOwnershipTransferDestinationOutputBridge()).toBe(true)
  const registry = runtime.getPtyOwnershipTransferDestinationRegistry()
  expect(registry?.supportsCapturedCatalogPublication()).toBe(false)
  expect(
    runtime.installPtyOwnershipTransferDestinationOutputBridge({ catalogPublicationVersion: 1 })
  ).toBe(false)
  expect(runtime.getPtyOwnershipTransferDestinationRegistry()).toBe(registry)
})

it('reconciles catalog publication through the production supervisor and source relay handlers', async () => {
  const f = await setup(true, true, true)
  const published = await prepareRemoteOrcadCapturedDestination(f.options).finally(() => {
    expect(f.errors.mock.calls).toEqual([])
  })
  expect(published.outcome).toBe('published')
  expect(f.errors.mock.calls).toEqual([])
  expect(f.lifecycle!.supervisor.getConnection(identity)?.isActive()).toBe(true)
  expect(f.source.inspectDestination(f.input.source!.proof, context()).phase).toBe('committed')
  await vi.waitFor(async () => {
    const model = await f.runtime.serializePublishedDelegatedPtyModel(identity)
    // The saved CSI prefix consumes the first suffix character as its final byte.
    expect(model?.data).toContain('one🙂ater')
    expect(model?.seq).toBe(f.model.modelSequenceEnd + 'later'.length)
  })
})

it('replays a durable desktop capture through encrypted catalog v2 after Store reload', async () => {
  const f = await setup(true)
  const desktopProfile = join(testState.dir, 'desktop')
  const captures = new OrcadOutgoingCaptureStore(desktopProfile)
  const saved = captures.persist({
    ...f.options.capture,
    version: 2,
    selection: f.selection,
    surfaceBinding: f.options.surfaceBinding,
    destinationEnvironmentId: 'paired-host',
    sourceSshTargetId: f.manifest.source.sshTargetId,
    sourceSshTargetGeneration: f.manifest.source.sshTargetGeneration
  })
  const publication = {
    ...saved,
    store: captures,
    pairingCode: f.options.pairingCode,
    signal: f.options.capture.signal,
    assertAuthority: () => {}
  }
  const prepared = await publishOutgoingOrcadCapture(publication)
  expect(prepared.outcome).toBe('published')
  expect(f.destinationStore.surface.loadCatalogAdmission(identity)).toEqual(f.catalogAdmission)
  expect(f.destinationStore.load(identity)?.phase).toBe('published')
  const requestOptions = { expectedRuntimeId: identity.destinationRuntimeId }
  const flush = vi
    .spyOn(f.store, 'flushPendingOrThrowAsync')
    .mockRejectedValueOnce(new Error('destination disk unavailable'))
  const commit = vi.fn(() =>
    commitRemoteOrcadMigrationCatalog(f.options.pairingCode, f.manifest, requestOptions)
  )
  const read = vi.fn(() =>
    readRemoteOrcadMigrationCatalogState(f.options.pairingCode, f.manifest, requestOptions)
  )
  const committed = await resolveDurableOrcadCatalogMutation(
    commit,
    read,
    (state) => state.state === 'committed'
  )
  expect(committed.state).toBe('committed')
  expect(commit).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenCalledOnce()
  expect(flush).toHaveBeenCalledTimes(2)
  flush.mockRestore()
  const session = f.store.getWorkspaceSession()
  const restored = f.reload()
  expect(restored.getOrcadMigrationCatalogState(f.manifest).state).toBe('committed')
  const layout = restored.getWorkspaceSession().terminalLayoutsByTabId['tab-1']
  expect(layout.root).toEqual(session.terminalLayoutsByTabId['tab-1'].root)
  expect(layout.ptyIdsByLeafId).toEqual(session.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId)
  const ref = ownershipTransferSurfaceModelSnapshotRef({
    surfaceBinding: f.options.surfaceBinding,
    publicationReceipt: prepared.publicationReceipt
  })
  expect(layout.scrollbackRefsByLeafId?.[f.options.surfaceBinding.leafId]).toBe(ref)
  expect(
    terminalScrollbackStoredBytesEqualSync(
      ref,
      f.model.modelData + f.model.restoreMetadata.pendingEscapeTailAnsi,
      { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFile()) }
    )
  ).toBe(true)
  f.rpc.mockClear()
  expect(
    await publishOutgoingOrcadCapture({
      ...publication,
      store: new OrcadOutgoingCaptureStore(desktopProfile)
    })
  ).toEqual(prepared)
  expect(captures.read(identity)).toEqual(saved)
  expect(f.rpc).not.toHaveBeenCalled()
})

it('refuses an encrypted disabled-host probe before contacting source or writing a journal', async () => {
  const f = await setup(false)
  await expect(prepareRemoteOrcadCapturedDestination(f.options)).rejects.toThrow(
    'catalog_negotiation_required'
  )
  expect(f.rpc).not.toHaveBeenCalled()
  expect(f.destinationStore.load(identity)).toBeNull()
  expect(createStore().getWorkspaceSession().tabsByWorktree['folder:folder-1']).toBeUndefined()
})

it('refuses a real encrypted catalog response from a runtime other than the admitted destination', async () => {
  const f = await setup(true)
  await expect(
    readRemoteOrcadMigrationCatalogState(f.options.pairingCode, f.manifest, {
      expectedRuntimeId: 'another-runtime'
    })
  ).rejects.toThrow('destination_runtime_mismatch')
  expect(f.store.getOrcadMigrationCatalogState(f.manifest).state).toBe('staged')
  expect(f.rpc).not.toHaveBeenCalled()
})

it('does not acknowledge encrypted commit recovery while destination flush remains unavailable', async () => {
  const f = await setup(true)
  await prepareRemoteOrcadCapturedDestination(f.options)
  const flush = vi
    .spyOn(f.store, 'flushPendingOrThrowAsync')
    .mockRejectedValue(new Error('destination disk unavailable'))
  const options = { expectedRuntimeId: identity.destinationRuntimeId }
  const commit = vi.fn(() =>
    commitRemoteOrcadMigrationCatalog(f.options.pairingCode, f.manifest, options)
  )
  const read = vi.fn(() =>
    readRemoteOrcadMigrationCatalogState(f.options.pairingCode, f.manifest, options)
  )
  await expect(
    resolveDurableOrcadCatalogMutation(commit, read, (state) => state.state === 'committed')
  ).rejects.toThrow('orcad_migration_commit_failed')
  expect(f.store.getOrcadMigrationCatalogState(f.manifest).state).toBe('committed')
  expect(commit).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenCalledOnce()
  expect(flush).toHaveBeenCalledTimes(2)
  flush.mockRestore()
  await f.store.flushPendingOrThrowAsync()
})

it('acknowledges encrypted abort recovery only after already-absent state is reflushable', async () => {
  const f = await setup(true)
  const options = { expectedRuntimeId: identity.destinationRuntimeId }
  const flush = vi
    .spyOn(f.store, 'flushPendingOrThrowAsync')
    .mockRejectedValueOnce(new Error('abort flush unavailable'))
    .mockRejectedValueOnce(new Error('abort retry flush unavailable'))
  const abort = () => abortRemoteOrcadMigrationCatalog(f.options.pairingCode, f.manifest, options)

  await expect(abort()).rejects.toThrow('abort flush unavailable')
  await expect(
    readRemoteOrcadMigrationCatalogState(f.options.pairingCode, f.manifest, options)
  ).resolves.toMatchObject({ state: 'absent' })
  await expect(abort()).rejects.toThrow('abort retry flush unavailable')
  await expect(abort()).resolves.toMatchObject({
    state: 'absent',
    aborted: false,
    durableAbsent: true
  })
  expect(flush).toHaveBeenCalledTimes(3)
  flush.mockRestore()
  const reloaded = f.reload()
  expect(reloaded.getOrcadMigrationCatalogState(f.manifest)).toMatchObject({ state: 'absent' })
})

it('resumes a desktop saved capture through full encrypted catalog stage, publication and commit', async () => {
  const f = await setup(true, false)
  const profileDirectory = join(testState.dir, 'desktop-live')
  const source = await liveDesktopProfileFixture(profileDirectory, f.manifest)
  let sourceStore = source.store
  desktop.target.mockImplementation((id) => sourceStore.getSshTarget(id))
  desktop.store.mockImplementation(() => sourceStore)
  desktop.provider.mockReturnValue(source.provider)
  const pairing = parsePairingCode(f.options.pairingCode)!
  desktop.environment.mockReturnValue({
    id: 'paired-host',
    runtimeId: identity.destinationRuntimeId,
    createdAt: 1,
    pairingRevision: 1,
    preferredEndpointId: 'endpoint',
    pairedDeviceId: pairing.pairedDeviceId,
    endpoints: [
      {
        id: 'endpoint',
        endpoint: pairing.endpoint,
        deviceToken: pairing.deviceToken,
        publicKeyB64: pairing.publicKeyB64
      }
    ]
  })
  const signal = new AbortController().signal
  let creationFenced = false
  source.provider.fenceOutgoingCatalogCreation.mockImplementation(async (fenceSignal) => {
    expect(fenceSignal).toBe(signal)
    fenceSignal.throwIfAborted()
    expect(sourceStore.getSshTarget(source.sourceId)?.owner).toBeUndefined()
    await Promise.resolve()
    creationFenced = true
  })
  const admit = sourceStore.beginOrcadLiveSourceCutover.bind(sourceStore)
  const admission = vi
    .spyOn(sourceStore, 'beginOrcadLiveSourceCutover')
    .mockImplementation((...args) => {
      expect(creationFenced).toBe(true)
      return admit(...args)
    })
  const initial = await withOrcadLiveSourceCutover(
    {
      profileDirectory,
      store: sourceStore,
      selector: 'paired-host',
      targetId: source.sourceId,
      migrationId: 'desktop-live',
      identities: [identity],
      runtime: source.runtime,
      signal
    },
    async (context) => {
      const catalogAdmission = parseOrcadTerminalLayoutAdmission({
        version: 1,
        manifest: context.cutover.manifest,
        bindings: [{ identity, surfaceBinding: source.surfaceBinding }]
      })
      const saved = {
        version: 2,
        identity,
        source: f.input.source,
        surfaceBinding: source.surfaceBinding,
        destinationEnvironmentId: 'paired-host',
        sourceSshTargetId: source.sourceId,
        sourceSshTargetGeneration: context.cutover.manifest.source.sshTargetGeneration,
        catalogAdmission
      }
      new OrcadOutgoingPreparationStore(profileDirectory).persistForSource(
        { ...saved, kind: 'preparation' },
        { provider: source.provider, providerGeneration: source.provider.providerGeneration }
      )
      new OrcadOutgoingCaptureStore(profileDirectory).persist({
        ...saved,
        model: f.model,
        selection: f.selection
      })
      return context.cutover
    }
  )
  expect(source.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledOnce()
  expect(admission).toHaveBeenCalledOnce()
  sourceStore = new Store({ dataFile: source.dataFile })
  const flush = sourceStore.flushPendingOrThrowAsync.bind(sourceStore)
  let publicationFlushFailed = false
  vi.spyOn(sourceStore, 'flushPendingOrThrowAsync').mockImplementation(async (options) => {
    const current = sourceStore.getOrcadMigrationSourceCutover(initial.manifest.migrationId)
    if (
      !publicationFlushFailed &&
      current?.phase === 'destination-staged' &&
      current.terminalPublications?.length
    ) {
      publicationFlushFailed = true
      throw new Error('desktop publication flush unavailable')
    }
    return flush(options)
  })
  await expect(
    resumeOrcadLiveDestination({
      profileDirectory,
      store: sourceStore,
      migrationId: initial.manifest.migrationId,
      runtime: source.runtime,
      signal
    })
  ).rejects.toThrow('desktop publication flush unavailable')
  expect(f.destinationStore.load(identity)?.phase).toBe('published')
  expect(f.store.getOrcadMigrationCatalogState(initial.manifest).state).toBe('staged')
  sourceStore = new Store({ dataFile: source.dataFile })
  f.rpc.mockClear()
  const result = await resumeOrcadLiveDestination({
    profileDirectory,
    store: sourceStore,
    migrationId: initial.manifest.migrationId,
    runtime: source.runtime,
    signal
  })
  expect(result.phase).toBe('destination-committed')
  expect(f.rpc).not.toHaveBeenCalled()
  expect(result.terminalPublications).toHaveLength(1)
  await expect(
    inspectOrcadLiveSourceReleaseReadiness({
      profileDirectory,
      store: sourceStore,
      migrationId: initial.manifest.migrationId,
      runtime: source.runtime,
      signal
    })
  ).rejects.toThrow('activation_negotiation_required')
  expect(sourceStore.getSshRemotePtyLeases(source.sourceId)).toHaveLength(1)
  expect(
    new Store({ dataFile: source.dataFile }).getOrcadMigrationSourceCutover(
      initial.manifest.migrationId
    )
  ).toEqual(result)
  expect(createStore().getOrcadMigrationCatalogState(initial.manifest).state).toBe('committed')
  expect(f.destinationStore.load(identity)?.phase).toBe('published')
  expect(source.provider.requestHostRpc).not.toHaveBeenCalled()
  expect(source.runtime.serializeSshPtyOwnershipCapture).not.toHaveBeenCalled()
  expect(sourceStore.getSshRemotePtyLeases(source.sourceId)).toHaveLength(1)
  const publications = result.terminalPublications!
  const ref = ownershipTransferSurfaceModelSnapshotRef({
    surfaceBinding: source.surfaceBinding,
    publicationReceipt: publications[0].publicationReceipt
  })
  const actualRef =
    f.store.getWorkspaceSession().terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId![
      source.surfaceBinding.leafId
    ]
  expect([
    ref,
    ownershipTransferSurfaceSnapshotRef({
      surfaceBinding: source.surfaceBinding,
      publicationReceipt: publications[0].publicationReceipt
    })
  ]).toContain(actualRef)
  expect(createStore().readTerminalScrollbackSnapshot(actualRef)).toBe(
    f.model.modelData + f.model.restoreMetadata.pendingEscapeTailAnsi
  )
  f.rpc.mockClear()
  sourceStore = new Store({ dataFile: source.dataFile })
  expect(
    await resumeOrcadLiveDestination({
      profileDirectory,
      store: sourceStore,
      migrationId: initial.manifest.migrationId,
      runtime: source.runtime,
      signal
    })
  ).toEqual(result)
  expect(f.rpc).not.toHaveBeenCalled()
})
