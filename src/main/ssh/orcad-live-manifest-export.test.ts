import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { testState } from '../persistence-test-harness'
import {
  setupSource,
  TARGET,
  DORMANT_LEAF_ID,
  receipt
} from '../orcad-migration-source-cutover-test-fixture'
import { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { beginOrcadLiveSourceCutoverDurably } from './orcad-live-cutover-admission'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { createStore } from '../persistence-test-harness'
import * as secure from '../../shared/secure-file'
import { withOrcadLiveSourceCutover } from './orcad-live-source-cutover'
import { withOrcadLiveSourceRecovery } from './orcad-live-source-recovery'
import { targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'
import { stageOrcadLiveDestination } from './orcad-live-destination-staging'
import type { OrcadMigrationCatalogState } from '../../shared/orcad-migration-manifest'
import { Store } from '../persistence'
import { stageOrcadMigrationCatalogDurably } from '../runtime/orcad-migration-catalog-import'
import { ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES } from '../../shared/orcad-migration-scrollback'
import { resumeOrcadLiveDestination } from './orcad-live-destination-coordinator'
import { liveSourceCaptureFixture } from './orcad-live-source-capture-test-fixture'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'

const transfer = vi.hoisted(() => ({ endpoint: vi.fn(), destination: vi.fn() }))
// These phase tests supply transport doubles; real peer readiness has separate live acceptance.
vi.mock('./orcad-live-migration-preflight', () => ({ assertOrcadLiveMigrationPreflight: vi.fn() }))
vi.mock('./orcad-outgoing-source-endpoint', () => ({
  discoverOutgoingOrcadSourceEndpoint: transfer.endpoint
}))
vi.mock('./orcad-captured-destination-client', () => ({
  prepareRemoteOrcadCapturedDestination: transfer.destination
}))

const registry = vi.hoisted(() => ({ provider: vi.fn(), route: vi.fn() }))
const host = vi.hoisted(() => ({ target: vi.fn(), store: vi.fn(), environment: vi.fn() }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: host.environment }))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({
    getTarget: host.target,
    getOrcadMigrationStore: host.store
  })
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: async () => {} }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.route
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-live-export-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  transfer.endpoint.mockReset()
  transfer.destination.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function fixture(buffer?: string) {
  const { store } = setupSource({ dormantSession: true })
  const identity = {
    bridgeId: 'bridge',
    terminalId: 'terminal',
    incarnationId: 'incarnation',
    ownerLease: 'owner',
    sourceOwnerGeneration: 1,
    destinationRuntimeId: 'runtime'
  }
  const worktreeId = 'repo-1::/srv/repo-1-worktree'
  const ptyId = toAppSshPtyId(TARGET.id, identity.terminalId)
  const surfaceBinding = {
    executionHostId: 'local' as const,
    workspaceKey: `worktree:${worktreeId}` as const,
    tabId: 'tab-dormant',
    leafId: DORMANT_LEAF_ID,
    ptyId: identity.terminalId
  }
  const session = store.getWorkspaceSession(`ssh:${TARGET.id}`)
  session.tabsByWorktree[worktreeId][0].ptyId = ptyId
  session.terminalLayoutsByTabId['tab-dormant'].ptyIdsByLeafId = { [DORMANT_LEAF_ID]: ptyId }
  if (buffer !== undefined) {
    session.terminalLayoutsByTabId['tab-dormant'].buffersByLeafId = { [DORMANT_LEAF_ID]: buffer }
  }
  session.terminalPtyIncarnationsByPaneKey = {
    [`tab-dormant:${DORMANT_LEAF_ID}`]: identity.incarnationId
  }
  store.setWorkspaceSession(session, `ssh:${TARGET.id}`)
  store.upsertSshRemotePtyLease({
    targetId: TARGET.id,
    ptyId: identity.terminalId,
    worktreeId,
    tabId: surfaceBinding.tabId,
    leafId: DORMANT_LEAF_ID,
    state: 'attached'
  })
  await store.upsertSshPtyConsumerRecovery({
    targetId: TARGET.id,
    clientInstanceId: 'client',
    serverBuildId: 'build',
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: identity.ownerLease
  })
  const provider = {
    fenceOutgoingCatalogCreation: vi.fn(),
    drainOutgoingSourceControls: vi.fn(async () => {}),
    providerGeneration: 1,
    requestHostRpc: vi.fn(),
    getOwnershipTransferSourceIdentity: () => identity
  }
  registry.provider.mockReturnValue(provider)
  registry.route.mockReturnValue(provider)
  const runtime = {
    bindOutgoingSshPtyCatalogSurfaces: () => ({
      surfaces: [{ ptyId, incarnationId: identity.incarnationId, surfaceBinding }],
      assertCurrent: () => {}
    })
  }
  const bound = bindOutgoingOrcadCatalogSource({
    targetId: TARGET.id,
    identities: [identity],
    store,
    runtime,
    signal: new AbortController().signal,
    assertAuthority: () => {}
  })
  return { store, bound, worktreeId, runtime, identity, provider }
}

it('exports the actual source catalog with admitted live layout and a zero uncovered dependency census', async () => {
  const f = await fixture()
  const before = f.store.getWorkspaceSession(`ssh:${TARGET.id}`)
  const leases = f.store.getSshRemotePtyLeases(TARGET.id)
  const manifest = createOrcadMigrationManifest(f.store, TARGET, {
    projectLiveSource: f.bound.projectSourceState
  })
  expect(
    manifest.payload.dormantState?.workspaceSession?.tabsByWorktree[f.worktreeId][0].ptyId
  ).toBeNull()
  expect(
    f.store.inspectOrcadMigrationSourceDependencies(manifest, f.bound.projectSourceState).totalCount
  ).toBe(0)
  expect(f.store.inspectOrcadMigrationSourceDependencies(manifest).totalCount).toBeGreaterThan(0)
  expect(f.store.getWorkspaceSession(`ssh:${TARGET.id}`)).toEqual(before)
  expect(f.store.getSshRemotePtyLeases(TARGET.id)).toEqual(leases)
  expect(() => f.store.beginOrcadMigrationSourceCutover(manifest, 'environment')).toThrow(
    'lease_unresolved'
  )
})

it('does not suppress unrelated remote-session authority from the projected census', async () => {
  const f = await fixture()
  const session = f.store.getWorkspaceSession(`ssh:${TARGET.id}`)
  session.remoteSessionIdsByTabId = { 'tab-dormant': 'unproven' }
  f.store.setWorkspaceSession(session, `ssh:${TARGET.id}`)
  const manifest = createOrcadMigrationManifest(f.store, TARGET, {
    projectLiveSource: f.bound.projectSourceState
  })
  expect(
    f.store.inspectOrcadMigrationSourceDependencies(manifest, f.bound.projectSourceState).totalCount
  ).toBeGreaterThan(0)
})

async function admissionFixture(buffer?: string) {
  const f = await fixture(buffer)
  const manifest = createOrcadMigrationManifest(f.store, TARGET, {
    projectLiveSource: f.bound.projectSourceState
  })
  const intent = {
    version: 2,
    phase: 'source-fenced',
    destinationEnvironmentId: 'environment',
    manifest,
    liveTerminalBindings: f.bound.bindings,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt
  }
  const options = {
    profileDirectory: testState.dir,
    store: f.store,
    intent,
    sourceAdmission: f.bound,
    signal: new AbortController().signal,
    assertAuthority: vi.fn((owner: 'unowned' | 'fenced') => {
      expect(f.store.getSshTarget(TARGET.id)?.owner).toEqual(
        owner === 'unowned'
          ? undefined
          : { type: 'on-demand-runtime', runtimeId: 'managed-orcad:environment' }
      )
    })
  }
  return { ...f, options }
}

it('retains intent before fencing and durably admits live source without removing session or leases', async () => {
  const f = await admissionFixture()
  const leases = f.store.getSshRemotePtyLeases(TARGET.id)
  const session = f.store.getWorkspaceSession(`ssh:${TARGET.id}`)
  const begin = f.store.beginOrcadLiveSourceCutover.bind(f.store)
  vi.spyOn(f.store, 'beginOrcadLiveSourceCutover').mockImplementationOnce((intent, project) => {
    expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toHaveLength(1)
    expect(f.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledOnce()
    return begin(intent, project)
  })
  const admitted = await beginOrcadLiveSourceCutoverDurably(f.options)
  expect(admitted.version).toBe(2)
  expect(createStore().getOrcadMigrationSourceCutover(admitted.manifest.migrationId)).toEqual(
    admitted
  )
  expect(f.store.getSshRemotePtyLeases(TARGET.id)).toEqual(leases)
  expect(f.store.getWorkspaceSession(`ssh:${TARGET.id}`)).toEqual(session)
  expect(await beginOrcadLiveSourceCutoverDurably(f.options)).toEqual(admitted)
})

it('retains the creation fence when initial intent persistence fails before source ownership changes', async () => {
  const f = await admissionFixture()
  vi.spyOn(OrcadLiveCutoverIntentStore.prototype, 'persist').mockImplementationOnce(() => {
    expect(f.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledOnce()
    throw new Error('intent flush unverifiable')
  })
  await expect(beginOrcadLiveSourceCutoverDurably(f.options)).rejects.toThrow(
    'intent flush unverifiable'
  )
  expect(f.store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
  expect(f.store.listOrcadMigrationSourceCutovers()).toEqual([])
  await beginOrcadLiveSourceCutoverDurably(f.options)
  expect(f.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledTimes(2)
})

it('does not persist intent or change ownership while pre-gate creation is unresolved', async () => {
  const f = await admissionFixture()
  const pending = Promise.withResolvers<void>()
  f.provider.fenceOutgoingCatalogCreation.mockReturnValueOnce(pending.promise)
  const admission = beginOrcadLiveSourceCutoverDurably(f.options)
  const rejection = expect(admission).rejects.toThrow('creation outcome unverifiable')
  await vi.waitFor(() => expect(f.provider.fenceOutgoingCatalogCreation).toHaveBeenCalledOnce())
  expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toEqual([])
  expect(f.store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
  pending.reject(new Error('creation outcome unverifiable'))
  await rejection
  expect(f.store.listOrcadMigrationSourceCutovers()).toEqual([])
})

it('does not install a source fence if retained intent durability is uncertain', async () => {
  const f = await admissionFixture()
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockReturnValueOnce(false)
  await expect(beginOrcadLiveSourceCutoverDurably(f.options)).rejects.toThrow(
    'permissions_unconfirmed'
  )
  expect(f.store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
  expect(f.store.listOrcadMigrationSourceCutovers()).toEqual([])
})

it.each(['bridgeId', 'ownerLease', 'incarnationId', 'destinationRuntimeId'] as const)(
  'refuses intent %s differing from admitted provider authority before writing intent',
  async (field) => {
    const f = await admissionFixture()
    Object.assign(f.options.intent.liveTerminalBindings[0].identity, { [field]: 'other' })
    await expect(beginOrcadLiveSourceCutoverDurably(f.options)).rejects.toThrow('binding_mismatch')
    expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toEqual([])
    expect(f.store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
  }
)

it('retains fenced live authority after profile flush failure and retries without replacing intent', async () => {
  const f = await admissionFixture()
  vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(beginOrcadLiveSourceCutoverDurably(f.options)).rejects.toThrow('disk unavailable')
  expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toHaveLength(1)
  expect(f.store.getSshTarget(TARGET.id)?.owner).toBeDefined()
  const admitted = await beginOrcadLiveSourceCutoverDurably(f.options)
  expect(createStore().getOrcadMigrationSourceCutover(admitted.manifest.migrationId)).toEqual(
    admitted
  )
})

it('composes real admission and owner re-pin under both locks and resumes the same initial cutover', async () => {
  const f = await fixture()
  host.target.mockImplementation((id) => f.store.getSshTarget(id))
  host.store.mockReturnValue(f.store)
  host.environment.mockReturnValue({
    id: 'environment',
    runtimeId: f.identity.destinationRuntimeId,
    createdAt: 1,
    pairingRevision: 1,
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ],
    preferredEndpointId: 'endpoint'
  })
  const options = {
    profileDirectory: testState.dir,
    store: f.store,
    selector: 'environment',
    targetId: TARGET.id,
    migrationId: 'combined-live',
    identities: [f.identity],
    runtime: f.runtime,
    signal: new AbortController().signal
  }
  const run = () =>
    withOrcadLiveSourceCutover(options, async (context) => {
      expect(targetLifecycleInFlight.has(TARGET.id)).toBe(true)
      expect(targetLifecycleInFlight.has(`runtime-ssh-access:${testState.dir}:environment`)).toBe(
        true
      )
      context.assertAuthority()
      context.sourceAdmission.assertCurrent()
      expect(createStore().getOrcadMigrationSourceCutover('combined-live')).toEqual(context.cutover)
      return context.cutover
    })
  const initial = await run()
  expect(await run()).toEqual(initial)
  expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toHaveLength(1)
  const stagedState: OrcadMigrationCatalogState = {
    state: 'staged',
    migrationId: initial.manifest.migrationId,
    manifestSha256: initial.manifest.manifestSha256,
    stagedAt: initial.startedAt
  }
  const remote = {
    read: vi
      .fn<() => Promise<OrcadMigrationCatalogState>>()
      .mockResolvedValueOnce({
        state: 'absent',
        migrationId: initial.manifest.migrationId,
        manifestSha256: initial.manifest.manifestSha256
      })
      .mockResolvedValue(stagedState),
    stage: vi
      .fn()
      .mockRejectedValueOnce(new Error('stage reply lost'))
      .mockResolvedValue(stagedState),
    snapshot: vi.fn()
  }
  const staged = await withOrcadLiveSourceCutover(options, async (context) =>
    stageOrcadLiveDestination({
      profileDirectory: testState.dir,
      store: f.store,
      ...context,
      signal: options.signal,
      remote
    })
  )
  expect(staged.phase).toBe('destination-staged')
  expect(createStore().getOrcadMigrationSourceCutover('combined-live')).toEqual(staged)
  expect(remote.stage).toHaveBeenCalledTimes(2)
  expect(remote.read).toHaveBeenCalledTimes(2)
  expect(remote.snapshot).not.toHaveBeenCalled()
  f.store = createStore()
  host.store.mockReturnValue(f.store)
  const recoveryOptions = { ...options, store: f.store }
  const recovered = await withOrcadLiveSourceRecovery(recoveryOptions, async (context) => {
    expect(targetLifecycleInFlight.has(TARGET.id)).toBe(true)
    expect(targetLifecycleInFlight.has(`runtime-ssh-access:${testState.dir}:environment`)).toBe(
      true
    )
    expect(context.cutover).toEqual(staged)
    context.assertAuthority()
    context.sourceAdmission.assertBindings(staged.liveTerminalBindings)
    return stageOrcadLiveDestination({
      ...recoveryOptions,
      ...context,
      remote
    })
  })
  expect(recovered).toEqual(staged)
  expect(createStore().getOrcadMigrationSourceCutover('combined-live')).toEqual(staged)
  expect(new OrcadLiveCutoverIntentStore(testState.dir).list()).toHaveLength(1)

  const operation = vi.fn()
  const flush = vi
    .spyOn(f.store, 'flushPendingOrThrowAsync')
    .mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(withOrcadLiveSourceRecovery(recoveryOptions, operation)).rejects.toThrow(
    'disk unavailable'
  )
  flush.mockRestore()
  expect(operation).not.toHaveBeenCalled()
  expect(createStore().getOrcadMigrationSourceCutover('combined-live')).toEqual(staged)
  const listing = vi.spyOn(f.store, 'listOrcadMigrationSourceCutovers').mockReturnValue([])
  await expect(withOrcadLiveSourceRecovery(recoveryOptions, operation)).rejects.toThrow(
    'phase_observation_required'
  )
  listing.mockRestore()
  expect(operation).not.toHaveBeenCalled()
  f.identity.incarnationId = 'replacement'
  await expect(withOrcadLiveSourceRecovery(recoveryOptions, operation)).rejects.toThrow(
    'source_inventory_mismatch'
  )
  expect(operation).not.toHaveBeenCalled()
  expect(createStore().getOrcadMigrationSourceCutover('combined-live')).toEqual(staged)
})

it('uploads exact live v2 snapshot bytes through real source and destination Stores after a lost chunk reply', async () => {
  const buffer = 'preserve multibyte 🐋\r\n'.repeat(12000)
  const bytes = Buffer.from(buffer, 'utf8')
  expect(bytes.length).toBeGreaterThan(ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES)
  const f = await admissionFixture(buffer)
  const initial = await beginOrcadLiveSourceCutoverDurably(f.options)
  expect(initial.manifest.payload.dormantState?.terminalScrollbackSnapshots).toHaveLength(1)
  const descriptor = initial.manifest.payload.dormantState!.terminalScrollbackSnapshots![0]
  const destinationFile = join(testState.dir, 'destination', 'orca-data.json')
  let destination = new Store({ dataFile: destinationFile })
  let lostReply = false
  const remote = {
    read: vi.fn(async (_pairing, manifest) => destination.getOrcadMigrationCatalogState(manifest)),
    stage: vi.fn(async (_pairing, manifest) =>
      stageOrcadMigrationCatalogDurably({ store: destination, manifest })
    ),
    snapshot: vi.fn(async (_pairing, request, options) => {
      expect(options.expectedRuntimeId).toBe('runtime')
      const result = destination.stageOrcadMigrationSnapshotChunk(request)
      await destination.flushPendingOrThrowAsync()
      if (!lostReply) {
        lostReply = true
        destination = new Store({ dataFile: destinationFile })
        throw new Error('chunk reply lost')
      }
      return result
    })
  }
  const staged = await stageOrcadLiveDestination({
    profileDirectory: testState.dir,
    store: f.store,
    cutover: initial,
    pairingCode: 'paired-transport-double',
    sourceAdmission: f.bound,
    signal: f.options.signal,
    assertAuthority: () => f.options.assertAuthority('fenced'),
    remote
  })
  expect(staged.phase).toBe('destination-staged')
  expect(remote.snapshot.mock.calls.map((call) => call[1].offset)).toEqual(
    Array.from(
      { length: Math.ceil(bytes.length / ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES) },
      (_, index) => index * ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES
    )
  )
  expect(
    new Store({ dataFile: destinationFile }).getOrcadMigrationCatalogState(initial.manifest)
  ).toMatchObject({
    state: 'staged',
    snapshotUploads: [{ ref: descriptor.ref, receivedBytes: bytes.length }]
  })
  destination.commitStagedOrcadMigrationCatalog(initial.manifest)
  await destination.flushPendingOrThrowAsync()
  expect(
    new Store({ dataFile: destinationFile }).readTerminalScrollbackSnapshot(descriptor.ref)
  ).toBe(buffer)
  expect(
    f.store.getWorkspaceSession(`ssh:${TARGET.id}`).terminalLayoutsByTabId['tab-dormant']
      .buffersByLeafId
  ).toEqual({ [DORMANT_LEAF_ID]: buffer })
  expect(createStore().getOrcadMigrationSourceCutover(initial.manifest.migrationId)).toEqual(staged)
})

it('resumes through real preparation and capture, retaining credentials and model across a lost publication reply', async () => {
  const f = await admissionFixture()
  const initial = await beginOrcadLiveSourceCutoverDurably(f.options)
  const capture = liveSourceCaptureFixture(testState.dir, f.identity)
  registry.provider.mockReturnValue(capture.provider)
  registry.route.mockReturnValue(capture.provider)
  host.target.mockImplementation((id) => f.store.getSshTarget(id))
  host.store.mockReturnValue(f.store)
  host.environment.mockReturnValue({
    id: 'environment',
    runtimeId: f.identity.destinationRuntimeId,
    createdAt: 1,
    pairingRevision: 1,
    preferredEndpointId: 'endpoint',
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ]
  })
  transfer.endpoint.mockImplementation(async (args) => {
    args.assertAuthority()
    return {
      endpoint: '/host/relay.sock',
      incumbentVersion: 'build',
      endpointCredential: 'a'.repeat(43)
    }
  })
  const surfaceBinding = initial.liveTerminalBindings![0].surfaceBinding
  const publication = {
    identity: f.identity,
    publicationReceipt: {
      version: 1,
      publicationReceiptId: 'published',
      bridgeId: f.identity.bridgeId,
      destinationRuntimeId: f.identity.destinationRuntimeId,
      surfaceBinding,
      publishedAt: initial.startedAt,
      commitReceipt: {
        receiptId: 'committed-terminal',
        bridgeId: f.identity.bridgeId,
        acceptedSourceEndSeq: 1,
        committedAt: initial.startedAt
      }
    }
  }
  transfer.destination
    .mockRejectedValueOnce(new Error('publication reply lost'))
    .mockResolvedValue(publication)
  const catalogIdentity = {
    migrationId: initial.manifest.migrationId,
    manifestSha256: initial.manifest.manifestSha256
  }
  const staged = { ...catalogIdentity, state: 'staged', stagedAt: initial.startedAt }
  const committed = { ...catalogIdentity, state: 'committed', receipt: receipt(initial.manifest) }
  const remote = {
    read: vi.fn().mockResolvedValue(staged),
    stage: vi.fn().mockResolvedValue(staged),
    snapshot: vi.fn(),
    commit: vi.fn().mockResolvedValue(committed)
  }
  const options = {
    profileDirectory: testState.dir,
    store: f.store,
    migrationId: initial.manifest.migrationId,
    signal: f.options.signal,
    runtime: {
      ...f.runtime,
      serializeSshPtyOwnershipCapture: capture.serializeSshPtyOwnershipCapture
    },
    remote
  }
  await expect(resumeOrcadLiveDestination(options)).rejects.toThrow('publication reply lost')
  const savedPreparation = new OrcadOutgoingPreparationStore(testState.dir).read(f.identity)
  const savedCapture = new OrcadOutgoingCaptureStore(testState.dir).read(f.identity)
  expect(savedPreparation?.version).toBe(2)
  expect(savedCapture?.model).toEqual(capture.model)
  expect(savedCapture?.catalogAdmission).toEqual(savedPreparation?.catalogAdmission)
  expect(remote.commit).not.toHaveBeenCalled()
  const sourceRequestCount = capture.provider.requestHostRpc.mock.calls.length
  expect(sourceRequestCount).toBeGreaterThan(0)
  f.store = createStore()
  host.store.mockReturnValue(f.store)
  const result = await resumeOrcadLiveDestination({ ...options, store: f.store })
  expect(result.phase).toBe('destination-committed')
  expect(capture.provider.requestHostRpc).toHaveBeenCalledTimes(sourceRequestCount)
  expect(capture.serializeSshPtyOwnershipCapture).toHaveBeenCalledOnce()
  expect(transfer.endpoint).toHaveBeenCalledOnce()
  expect(new OrcadOutgoingPreparationStore(testState.dir).read(f.identity)).toEqual(
    savedPreparation
  )
  expect(new OrcadOutgoingCaptureStore(testState.dir).read(f.identity)).toEqual(savedCapture)
  expect(createStore().getOrcadMigrationSourceCutover(initial.manifest.migrationId)).toEqual(result)
  remote.read.mockResolvedValue(committed)
  expect(await resumeOrcadLiveDestination({ ...options, store: f.store })).toEqual(result)
  expect(transfer.destination).toHaveBeenCalledTimes(2)
  expect(capture.provider.requestHostRpc).toHaveBeenCalledTimes(sourceRequestCount)
})
