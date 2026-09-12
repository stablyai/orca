import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistedState } from '../shared/persisted-state-types'
import { parseOrcadMigrationSourceCutover } from '../shared/orcad-migration-source-cutover'
import { getSecretStore } from '../shared/secret-store'
import { createStore, readDataFile, testState, writeDataFile } from './persistence-test-harness'
import { liveSourceRetirementFixture } from './persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { projectOrcadSourceLiveState } from './persistence/migrating-orcad-catalog/orcad-source-live-state-projection'
import { createOrcadMigrationManifest } from './ssh/orcad-migration-manifest-export'
import { receipt } from './orcad-migration-source-cutover-test-fixture'
import { OrcadLiveSourceRetirementRecordStore } from './ssh/orcad-live-source-retirement-record'
import { inspectOrcadLiveRetirementRecovery } from './ssh/orcad-live-retirement-recovery-inspection'
import { installOrcadLiveProfileUnderAuthority } from './ssh/orcad-live-profile-installation'
import { installOrcadLiveSourceProfile } from './ssh/orcad-live-source-profile-installation'
import { OrcadLiveCutoverIntentStore } from './ssh/orcad-live-cutover-intent-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../shared/pty-ownership-transfer-release-gate'
import { toAppSshPtyId } from '../shared/ssh-pty-id'
import { targetLifecycleInFlight } from './ipc/ssh-target-lifecycle-queue'
import { releaseOrcadLiveSourceControls } from './ssh/orcad-live-source-control-release'
import { parseOrcadCatalogActivationRequest } from './ssh/orcad-catalog-activation-contract'
import { SshPtyProvider } from './providers/ssh-pty-provider'
import { parsePtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { liveSourceOutputFixture } from './ssh/orcad-live-source-output-test-fixture'
import { sshPtyOutputEvent } from './ipc/ssh-pty-output-intake-test-harness'
import { requireSshPtyLiveSourceSettlement } from './ipc/ssh-pty-output-intake-registry'
import * as secureFile from '../shared/secure-file'
import { assertOutgoingPtyRegistrationAllowed } from './runtime/outgoing-pty-registration-fence'
import { registerLiveRuntimeCleanupTests } from './ssh/orcad-live-source-runtime-cleanup-test-cases'
import { registerLiveRuntimeLifecycleTests } from './ssh/orcad-live-runtime-lifecycle-test-cases'
import { registerLiveProfileFlushAuthorityTests } from './ssh/orcad-live-profile-flush-authority-test-cases'
import { registerLiveCompletionLifecycleTests } from './ssh/orcad-live-completion-lifecycle-test-cases'

let uninstallOutput = () => {}

const host = vi.hoisted(() => ({ target: vi.fn(), store: vi.fn(), environment: vi.fn() }))
const registry = vi.hoisted(() => ({ provider: vi.fn(), route: vi.fn() }))
vi.mock('../shared/runtime-environment-store', () => ({ resolveEnvironment: host.environment }))
vi.mock('./ssh/orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({
    getTarget: host.target,
    getOrcadMigrationStore: host.store
  })
}))
vi.mock('./ssh/orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: async () => {} }))
vi.mock('./ipc/pty/provider/registry', async () => ({
  ...(await vi.importActual('./ipc/pty/provider/registry')),
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.route
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-retirement-install-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
})
afterEach(() => {
  uninstallOutput()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function fixture(
  canonicalMetadata = false,
  retainRetirementRecord = true,
  kind: 'folder' | 'worktree' = 'folder'
) {
  const seed = liveSourceRetirementFixture(kind, randomUUID())
  for (const recovery of seed.state.sshPtyConsumerRecoveries ?? []) {
    recovery.ownerLease = getSecretStore().encryptString(recovery.ownerLease).toString('base64')
  }
  writeDataFile(seed.state)
  const loaded = createStore()
  const target = loaded.getSshTarget(seed.cutover.manifest.source.sshTargetId)!
  if (canonicalMetadata) {
    loaded.setWorktreeMetaForHost('folder:folder-1', seed.hostId, {
      instanceId: 'folder-instance',
      comment: 'canonical folder metadata'
    })
  }
  const evidence = {
    bindings: seed.cutover.liveTerminalBindings!,
    leases: loaded.getSshRemotePtyLeases(target.id),
    recovery: loaded.getSshPtyConsumerRecovery(target.id)!
  }
  const project = (
    state: Parameters<typeof projectOrcadSourceLiveState>[0],
    source: Parameters<typeof projectOrcadSourceLiveState>[1],
    catalog: Parameters<typeof projectOrcadSourceLiveState>[2]
  ) => projectOrcadSourceLiveState(state, source, catalog, evidence)
  const manifest = createOrcadMigrationManifest(loaded, target, {
    migrationId: seed.cutover.manifest.migrationId,
    destinationEnvironmentId: 'environment',
    projectLiveSource: project,
    now: () => new Date(seed.cutover.manifest.createdAt)
  })
  const cutover = parseOrcadMigrationSourceCutover({
    ...seed.cutover,
    manifest,
    receipt: receipt(manifest),
    terminalPublications: seed.cutover.terminalPublications!.map((publication) => ({
      ...publication,
      catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    }))
  })
  await loaded.flushPendingOrThrowAsync()
  const saved = readDataFile() as PersistedState
  saved.orcadMigrationSourceCutovers = [cutover]
  writeDataFile(saved)
  const store = createStore()
  host.target.mockImplementation((id: string) => store.getSshTarget(id))
  host.store.mockReturnValue(store)
  host.environment.mockReturnValue({
    id: 'environment',
    runtimeId: cutover.liveTerminalBindings![0].identity.destinationRuntimeId,
    createdAt: 1,
    pairingRevision: 1,
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ],
    preferredEndpointId: 'endpoint'
  })
  new OrcadLiveCutoverIntentStore(testState.dir).persist({
    ...cutover,
    phase: 'source-fenced',
    updatedAt: cutover.startedAt,
    terminalPublications: undefined
  })
  const sourceAdmission = {
    assertBindings: vi.fn<() => void>(),
    assertCurrent: vi.fn<() => void>(),
    projectSourceState: project
  }
  const release = {
    version: 1,
    cutover,
    activations: cutover.terminalPublications!.map((publication) => ({
      version: 1,
      identity: publication.identity,
      publicationReceipt: publication.publicationReceipt,
      destinationClaim: { generation: 1, claimId: 'claim' },
      catalog: publication.catalog
    }))
  }
  const record = store.createOrcadLiveSourceRetirementRecord(release, sourceAdmission)
  if (retainRetirementRecord) {
    new OrcadLiveSourceRetirementRecordStore(testState.dir).persist(record)
  }
  const install = () =>
    store.installOrcadLiveRetirementProfile(record, sourceAdmission, cutover.updatedAt)
  const acknowledge = (source = sourceAdmission) =>
    installOrcadLiveProfileUnderAuthority({
      store,
      record,
      sourceAdmission: source,
      profileDirectory: testState.dir,
      signal: new AbortController().signal,
      assertAuthority: () => {}
    })
  return { store, record, install, target, cutover, acknowledge, sourceAdmission }
}

it.each([false, true])(
  'flushes scoped retirement and marker together and recognizes them after Store reload (canonical metadata=%s)',
  async (canonicalMetadata) => {
    const f = await fixture(canonicalMetadata)
    expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('prepared')
    const marker = f.install()
    await f.store.flushPendingOrThrowAsync()
    const restored = createStore()
    expect(restored.listOrcadLiveRetirementMarkers()).toEqual([marker])
    expect(restored.getSshRemotePtyLeases(f.target.id)).toEqual([])
    expect(restored.getSshTarget(f.target.id)?.owner).toEqual(f.target.owner)
    if (canonicalMetadata) {
      expect(f.record.changes.map((entry) => entry.field)).toEqual(
        expect.arrayContaining(['worktreeMetaByIdentity', 'worktreeIdentityAliases'])
      )
      expect(restored.getAllWorktreeMetaForHost(`ssh:${f.target.id}`)).toEqual({})
    }
    expect(restored.inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
      'profile-installed'
    )
    expect(inspectOrcadLiveRetirementRecovery(testState.dir, restored)[0].state).toBe(
      'profile-installed'
    )
  }
)

it('keeps the prior durable source profile intact when installation flush fails, then reflushes the installed state', async () => {
  const f = await fixture()
  await f.store.flushPendingOrThrowAsync()
  const before = readDataFile()
  const flush = vi
    .spyOn(f.store, 'flushPendingOrThrowAsync')
    .mockRejectedValueOnce(new Error('disk full'))
  await expect(f.acknowledge()).rejects.toThrow('disk full')
  expect(readDataFile()).toEqual(before)
  const old = createStore()
  expect(old.listOrcadLiveRetirementMarkers()).toEqual([])
  expect(old.getSshRemotePtyLeases(f.target.id)).toHaveLength(2)
  expect(old.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('prepared')
  flush.mockRestore()
  await installOrcadLiveProfileUnderAuthority({
    store: f.store,
    record: f.record,
    profileDirectory: testState.dir,
    signal: new AbortController().signal,
    assertAuthority: () => {}
  })
  expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
    'profile-installed'
  )
})

it('replays an installed profile through the completion-aware entry without any source provider binding', async () => {
  const f = await fixture()
  await f.acknowledge()
  const restored = createStore()
  host.target.mockImplementation((id: string) => restored.getSshTarget(id))
  host.store.mockReturnValue(restored)
  const bind = vi.fn(() => {
    throw new Error('source must not be rebound')
  })
  const result = await installOrcadLiveSourceProfile({
    store: restored,
    profileDirectory: testState.dir,
    migrationId: f.cutover.manifest.migrationId,
    signal: new AbortController().signal,
    runtime: { bindOutgoingSshPtyCatalogSurfaces: bind }
  })
  expect(result.record).toEqual(f.record)
  expect(result.marker.recordSha256).toBe(f.record.sha256)
  expect(bind).not.toHaveBeenCalled()
})

it('does not acknowledge installation after authority is lost during the real profile flush', async () => {
  const f = await fixture()
  const authority = vi.fn()
  const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
  vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
    await flush(options)
    authority.mockImplementation(() => {
      throw new Error('authority lost')
    })
  })
  await expect(
    installOrcadLiveProfileUnderAuthority({
      store: f.store,
      record: f.record,
      sourceAdmission: f.sourceAdmission,
      profileDirectory: testState.dir,
      signal: new AbortController().signal,
      assertAuthority: authority
    })
  ).rejects.toThrow('authority lost')
  expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
    'profile-installed'
  )
})

export async function preparedEntryFixture(
  retainRetirementRecord = true,
  kind: 'folder' | 'worktree' = 'folder'
) {
  const f = await fixture(false, retainRetirementRecord, kind)
  if (f.cutover.phase !== 'destination-committed') {
    throw new Error('fixture requires committed cutover')
  }
  const bindings = f.cutover.liveTerminalBindings!
  const requestHostRpc: Mock = vi.fn()
  const provider = {
    providerGeneration: 1,
    requestHostRpc,
    getOwnershipTransferSourceIdentity: (ptyId: string) =>
      bindings.find(({ identity }) => toAppSshPtyId(f.target.id, identity.terminalId) === ptyId)
        ?.identity
  }
  registry.provider.mockReturnValue(provider)
  registry.route.mockReturnValue(provider)
  const assertLocked = () => {
    expect(targetLifecycleInFlight.has(f.target.id)).toBe(true)
    expect(targetLifecycleInFlight.has(`runtime-ssh-access:${testState.dir}:environment`)).toBe(
      true
    )
  }
  const runtime = {
    settleOutgoingSshPtyCatalogModels: vi.fn(async (): Promise<{ assertCurrent: () => void }> => ({
      assertCurrent: assertInventory
    })),
    bindOutgoingSshPtyCatalogSurfaces: vi.fn(() => ({
      surfaces: bindings.map(({ identity, surfaceBinding }) => ({
        ptyId: toAppSshPtyId(f.target.id, identity.terminalId),
        incarnationId: identity.incarnationId,
        surfaceBinding
      })),
      assertCurrent: assertInventory
    }))
  }
  const assertInventory = vi.fn(assertLocked)
  const committed = {
    state: 'committed' as const,
    migrationId: f.cutover.manifest.migrationId,
    manifestSha256: f.cutover.manifest.manifestSha256,
    receipt: f.cutover.receipt!
  }
  const remote = {
    read: vi.fn(async () => committed),
    commit: vi.fn(async () => {
      assertLocked()
      return committed
    })
  }
  const activate = vi.fn<
    NonNullable<Parameters<typeof installOrcadLiveSourceProfile>[0]['activate']>
  >(async ({ request }) => {
    assertLocked()
    expect(f.store.getSshRemotePtyLeases(f.target.id)).toHaveLength(2)
    const parsed = parseOrcadCatalogActivationRequest(request)
    return {
      version: 1,
      identity: parsed.identity,
      publicationReceipt: parsed.publicationReceipt,
      destinationClaim: { generation: 1, claimId: 'claim' },
      catalog: {
        migrationId: f.cutover.manifest.migrationId,
        manifestSha256: f.cutover.manifest.manifestSha256
      }
    }
  })
  const run = () =>
    installOrcadLiveSourceProfile({
      store: f.store,
      profileDirectory: testState.dir,
      migrationId: f.cutover.manifest.migrationId,
      runtime,
      remote,
      activate,
      signal: new AbortController().signal
    })
  return { ...f, run, remote, activate, provider, runtime, assertInventory }
}

export async function controlReleaseFixture(
  kind: 'folder' | 'worktree' = 'folder',
  installProfile = true
) {
  const f = await preparedEntryFixture(true, kind)
  await (installProfile ? f.run() : Promise.resolve())
  const output = await liveSourceOutputFixture(
    f.cutover.liveTerminalBindings!.map(({ identity }) => ({
      identity,
      ptyId: toAppSshPtyId(f.target.id, identity.terminalId),
      providerGeneration: f.provider.providerGeneration
    }))
  )
  uninstallOutput = output.uninstall
  const released = new Set<string>()
  const mux = {
    fencePtyControlsAndDrain: vi.fn(async () => {}),
    fencePtyPreparationSurface: vi.fn<() => void>(),
    isDisposed: vi.fn(() => false),
    dispose: vi.fn<() => void>(),
    notify: vi.fn<() => void>(),
    request: vi.fn(async () => ({})),
    onNotification: vi.fn(() => vi.fn<() => void>()),
    onNotificationByMethod: vi.fn(() => vi.fn<() => void>()),
    onDispose: vi.fn(() => vi.fn<() => void>())
  }
  const provider = new SshPtyProvider(
    f.target.id,
    mux as never,
    undefined,
    f.provider.providerGeneration
  )
  vi.spyOn(provider, 'getOwnershipTransferSourceIdentity').mockImplementation(
    (id) => f.provider.getOwnershipTransferSourceIdentity(toAppSshPtyId(f.target.id, id)) ?? null
  )
  registry.provider.mockReturnValue(provider)
  registry.route.mockImplementation((id: string) => {
    if (provider.isOutgoingSourceControlReleased(id)) {
      throw new Error('orcad_outgoing_source_control_released')
    }
    return provider
  })
  const apply = provider.releaseOutgoingSourceControl
  const releaseControl = vi
    .spyOn(provider, 'releaseOutgoingSourceControl')
    .mockImplementation((value) => {
      apply(value)
      released.add(parsePtyOwnershipTransferWireIdentity(value.identity).terminalId)
    })
  f.activate.mockImplementation(async ({ request }) => {
    const parsed = parseOrcadCatalogActivationRequest(request)
    return f.record.release.activations.find(
      (entry) => entry.identity.bridgeId === parsed.identity.bridgeId
    )!
  })
  const release = () =>
    releaseOrcadLiveSourceControls({
      profileDirectory: testState.dir,
      store: f.store,
      migrationId: f.cutover.manifest.migrationId,
      runtime: f.runtime,
      signal: new AbortController().signal,
      remote: f.remote,
      activate: f.activate
    })
  return { ...f, provider, mux, released, releaseControl, release, output }
}

registerLiveRuntimeCleanupTests(controlReleaseFixture)
registerLiveRuntimeLifecycleTests(controlReleaseFixture)

it('revalidates installed profile, committed destination and complete activation before retryable control release', async () => {
  const f = await controlReleaseFixture()
  const before = readDataFile()
  const result = await f.release()
  expect(result.cleanupIntent.phase).toBe('cleanup-prepared')
  for (const { identity } of f.cutover.liveTerminalBindings!) {
    expect(() =>
      assertOutgoingPtyRegistrationAllowed(
        f.runtime,
        toAppSshPtyId(f.target.id, identity.terminalId)
      )
    ).toThrow('source_registration_fenced')
  }
  expect(inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].cleanupPrepared).toBe(true)
  expect(result.sourceOutputSettlements).toHaveLength(2)
  expect(result.sourceOutputSettlements).toEqual(
    f.cutover.liveTerminalBindings!.map(({ identity }, index) => ({
      id: identity.terminalId,
      providerGeneration: f.provider.providerGeneration,
      clientGeneration: 1,
      ownerGeneration: identity.sourceOwnerGeneration,
      ptyIncarnation: identity.incarnationId,
      deliveryToken: `token-${index}`,
      fromSourceEndSu: 0,
      throughSourceEndSu: 4
    }))
  )
  expect(f.released.size).toBe(2)
  await f.release()
  expect(f.releaseControl).toHaveBeenCalledTimes(4)
  expect(f.activate).toHaveBeenCalledTimes(10)
  expect(readDataFile()).toEqual(before)
  for (const { identity } of f.cutover.liveTerminalBindings!) {
    const ptyId = toAppSshPtyId(f.target.id, identity.terminalId)
    await expect(f.provider.writeWithSettlement(ptyId, 'stale input')).resolves.toEqual({
      outcome: 'refused',
      reason: 'write_gate_denied'
    })
    await expect(f.provider.shutdown(ptyId, { immediate: true })).rejects.toThrow(
      'source_control_released'
    )
  }
  expect(f.mux.request).not.toHaveBeenCalled()
  expect(f.mux.notify).not.toHaveBeenCalled()
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('does not acknowledge source release while model settlement is pending or fails', async () => {
  const f = await controlReleaseFixture()
  const before = readDataFile()
  const pending = Promise.withResolvers<{ assertCurrent: () => void }>()
  f.runtime.settleOutgoingSshPtyCatalogModels.mockImplementationOnce(() => pending.promise)
  const releasing = f.release()
  const refused = expect(releasing).rejects.toThrow('model work failed')
  await vi.waitFor(() => expect(f.runtime.settleOutgoingSshPtyCatalogModels).toHaveBeenCalledOnce())
  expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledTimes(2)
  expect(f.released.size).toBe(2)
  pending.reject(new Error('model work failed'))
  await refused
  expect(readDataFile()).toEqual(before)
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('revalidates incumbent authority after awaiting model settlement', async () => {
  const f = await controlReleaseFixture()
  f.runtime.settleOutgoingSshPtyCatalogModels.mockImplementationOnce(async () => {
    registry.provider.mockReturnValue({ ...f.provider })
    return { assertCurrent: f.assertInventory }
  })
  await expect(f.release()).rejects.toThrow('source_authority_changed')
  expect(f.released.size).toBe(2)
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('does not acknowledge cleanup preparation after an uncertain write and reflushes exact retry', async () => {
  const f = await controlReleaseFixture()
  const original = secureFile.writeDurableSecureJsonFile
  let cleanupWrites = 0
  vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementation((path, value) => {
    const result = original(path, value)
    if (String(path).includes('orcad-live-source-cleanup-intents') && ++cleanupWrites === 1) {
      throw new Error('cleanup durability uncertain')
    }
    return result
  })
  await expect(f.release()).rejects.toThrow('cleanup durability uncertain')
  for (const { identity } of f.cutover.liveTerminalBindings!) {
    expect(() =>
      assertOutgoingPtyRegistrationAllowed(
        f.runtime,
        toAppSshPtyId(f.target.id, identity.terminalId)
      )
    ).not.toThrow()
  }
  expect(f.released.size).toBe(2)
  expect(f.mux.dispose).not.toHaveBeenCalled()
  await expect(f.release()).resolves.toHaveProperty('cleanupIntent.phase', 'cleanup-prepared')
  expect(cleanupWrites).toBe(2)
})

it.each(['claim', 'unavailable', 'output'] as const)(
  'refuses %s changes during the final authenticated activation check and preserves retry',
  async (change) => {
    const f = await controlReleaseFixture()
    const before = readDataFile()
    const activate = f.activate.getMockImplementation()!
    let calls = 0
    f.activate.mockImplementation(async (args) => {
      const result = await activate(args)
      if (++calls !== 3) {
        return result
      }
      expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledTimes(2)
      expect(f.runtime.settleOutgoingSshPtyCatalogModels).toHaveBeenCalledOnce()
      if (change === 'unavailable') {
        throw new Error('destination unavailable')
      }
      if (change === 'output') {
        f.output.uninstall()
        return result
      }
      return {
        ...result,
        destinationClaim: {
          ...result.destinationClaim,
          generation: result.destinationClaim.generation + 1
        }
      }
    })
    await expect(f.release()).rejects.toThrow(
      {
        claim: 'activation_changed',
        unavailable: 'destination unavailable',
        output: 'source_output_identity_unverifiable'
      }[change]
    )
    expect(f.released.size).toBe(2)
    expect(readDataFile()).toEqual(before)
    expect(f.mux.dispose).not.toHaveBeenCalled()
    expect(f.output.order).not.toContain('exit')
    if (change !== 'output') {
      f.activate.mockImplementation(activate)
      await f.release()
      expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledTimes(4)
    }
  }
)

it('refuses pending desktop output after drain and permits an exact retry after output settles', async () => {
  const f = await controlReleaseFixture()
  const before = readDataFile()
  const identity = f.cutover.liveTerminalBindings![0].identity
  const ptyId = toAppSshPtyId(f.target.id, identity.terminalId)
  const pending = f.output.intake.acceptData(
    sshPtyOutputEvent({
      id: ptyId,
      providerGeneration: f.provider.providerGeneration,
      ptyIncarnation: identity.incarnationId,
      source: {
        relayPtyId: identity.terminalId,
        spanId: 'span-late',
        clientGeneration: 1,
        ownerGeneration: identity.sourceOwnerGeneration,
        deliveryToken: 'token-0',
        sourceStartSu: 4,
        sourceEndSu: 8
      }
    })
  )
  f.output.completions.at(-1)!.resolve()
  const receipt = await pending
  await expect(f.release()).rejects.toThrow('settlement_unavailable')
  expect(f.released.size).toBe(2)
  expect(readDataFile()).toEqual(before)
  f.output.intake.publishProjectionPrefix([receipt.projection.identity.projectionSemanticsId], 4, 4)
  f.output.intake.settleProjectionPrefix(ptyId, 4)
  await vi.waitFor(() =>
    requireSshPtyLiveSourceSettlement(
      f.output.intake
        .getAcceptedSourceCheckpoints(f.provider.providerGeneration)
        .find((entry) => entry.id === ptyId)!
    )
  )
  const result = await f.release()
  expect(result.sourceOutputSettlements[0].throughSourceEndSu).toBe(8)
  expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledTimes(4)
  expect(readDataFile()).toEqual(before)
  expect(f.mux.dispose).not.toHaveBeenCalled()
  expect(f.output.order).not.toContain('exit')
})

it('refuses the entire control cohort before fencing when one incumbent identity is unavailable', async () => {
  const f = await controlReleaseFixture()
  const read = vi.mocked(f.provider.getOwnershipTransferSourceIdentity).getMockImplementation()!
  const missing = f.cutover.liveTerminalBindings![1].identity.terminalId
  vi.spyOn(f.provider, 'getOwnershipTransferSourceIdentity').mockImplementation((id) =>
    id === toAppSshPtyId(f.target.id, missing) ? null : read(id)
  )
  await expect(f.release()).rejects.toThrow('source_authority_changed')
  expect(f.releaseControl).not.toHaveBeenCalled()
})

it('fences the whole cohort before waiting for admitted controls to settle', async () => {
  const f = await controlReleaseFixture()
  const pending = Promise.withResolvers<void>()
  f.mux.fencePtyControlsAndDrain.mockImplementationOnce(() => pending.promise)
  let finished = false
  const releasing = f.release().then(() => {
    finished = true
  })
  await vi.waitFor(() => expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledOnce())
  expect(f.released.size).toBe(2)
  expect(finished).toBe(false)
  pending.resolve()
  await releasing
  expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledTimes(2)
  expect(f.mux.fencePtyPreparationSurface).toHaveBeenCalledTimes(2)
  for (const { identity, surfaceBinding } of f.cutover.liveTerminalBindings!) {
    expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledWith(
      identity.terminalId,
      expect.any(AbortSignal)
    )
    expect(f.mux.fencePtyPreparationSurface).toHaveBeenCalledWith(surfaceBinding)
  }
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('requires settlement support before changing any source control fence', async () => {
  const f = await controlReleaseFixture()
  Object.defineProperty(f.provider, 'drainOutgoingSourceControls', { value: undefined })
  await expect(f.release()).rejects.toThrow('provider_unsupported')
  expect(f.releaseControl).not.toHaveBeenCalled()
  expect(f.released.size).toBe(0)
})

it('retains all control fences after failed settlement and drains again on explicit retry', async () => {
  const f = await controlReleaseFixture()
  const before = readDataFile()
  f.mux.fencePtyControlsAndDrain.mockRejectedValueOnce(new Error('RPC settlement unverifiable'))
  await expect(f.release()).rejects.toThrow('RPC settlement unverifiable')
  expect(f.released.size).toBe(2)
  expect(readDataFile()).toEqual(before)
  await f.release()
  expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledTimes(3)
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('refuses provider replacement while release settlement is pending', async () => {
  const f = await controlReleaseFixture()
  const pending = Promise.withResolvers<void>()
  f.mux.fencePtyControlsAndDrain.mockImplementationOnce(() => pending.promise)
  const releasing = f.release()
  const rejection = expect(releasing).rejects.toThrow('authority_changed')
  await vi.waitFor(() => expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledOnce())
  registry.provider.mockReturnValue({ ...f.provider })
  pending.resolve()
  await rejection
  expect(f.released.size).toBe(2)
  expect(f.mux.fencePtyControlsAndDrain).toHaveBeenCalledOnce()
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('retries a partially fenced cohort without undoing the first fence or changing the installed profile', async () => {
  const f = await controlReleaseFixture()
  const before = readDataFile()
  const release = f.releaseControl.getMockImplementation()!
  f.releaseControl.mockImplementationOnce(release).mockImplementationOnce(() => {
    throw new Error('release interrupted')
  })
  await expect(f.release()).rejects.toThrow('release interrupted')
  expect(f.released.size).toBe(1)
  await f.release()
  expect(f.released.size).toBe(2)
  expect(readDataFile()).toEqual(before)
})

it('does not fence any source control when fresh destination activation is unavailable', async () => {
  const f = await controlReleaseFixture()
  f.activate.mockRejectedValueOnce(new Error('destination unavailable'))
  await expect(f.release()).rejects.toThrow('destination unavailable')
  expect(f.releaseControl).not.toHaveBeenCalled()
  expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('profile-installed')
})

it('refuses a changed destination claim at the retained generation before fencing controls', async () => {
  const f = await controlReleaseFixture()
  const activate = f.activate.getMockImplementation()!
  f.activate.mockImplementationOnce(async (args) => {
    const result = await activate(args)
    return { ...result, destinationClaim: { ...result.destinationClaim, claimId: 'conflicting' } }
  })
  await expect(f.release()).rejects.toThrow('activation_regressed')
  expect(f.releaseControl).not.toHaveBeenCalled()
})

it('rechecks target lifecycle authority after activation before releasing source controls', async () => {
  const f = await controlReleaseFixture()
  const activate = f.activate.getMockImplementation()!
  f.activate.mockImplementationOnce(async (args) => {
    const result = await activate(args)
    host.target.mockReturnValue({
      ...f.target,
      generation: (f.cutover.manifest.source.sshTargetGeneration ?? 0) + 1
    })
    return result
  })
  await expect(f.release()).rejects.toThrow('authority_changed')
  expect(f.releaseControl).not.toHaveBeenCalled()
  expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
})

it('keeps public control release disabled without the mutation canary', async () => {
  const f = await controlReleaseFixture()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
  await expect(f.release()).rejects.toThrow('mutation_disabled')
  expect(f.releaseControl).not.toHaveBeenCalled()
})

it.each(['reordered', 'duplicate'] as const)(
  'matches the full control cohort by exact terminal identity (%s)',
  async (change) => {
    const f = await controlReleaseFixture()
    const bind = f.runtime.bindOutgoingSshPtyCatalogSurfaces.getMockImplementation()!
    f.runtime.bindOutgoingSshPtyCatalogSurfaces.mockImplementation(() => {
      const inventory = bind()
      return {
        ...inventory,
        surfaces:
          change === 'reordered'
            ? inventory.surfaces.toReversed()
            : [inventory.surfaces[0], inventory.surfaces[0]]
      }
    })
    if (change === 'reordered') {
      await f.release()
      expect(f.released.size).toBe(2)
    } else {
      await expect(f.release()).rejects.toThrow('inventory_mismatch')
      expect(f.releaseControl).not.toHaveBeenCalled()
    }
  }
)

it('refuses public control release before durable profile installation', async () => {
  const f = await fixture()
  const bind = vi.fn(() => {
    throw new Error('must not bind')
  })
  await expect(
    releaseOrcadLiveSourceControls({
      profileDirectory: testState.dir,
      store: f.store,
      migrationId: f.cutover.manifest.migrationId,
      signal: new AbortController().signal,
      runtime: {
        bindOutgoingSshPtyCatalogSurfaces: bind,
        settleOutgoingSshPtyCatalogModels: vi.fn()
      }
    })
  ).rejects.toThrow('installed_profile_required')
  expect(bind).not.toHaveBeenCalled()
})

it.each([false, true])(
  'installs under real lifecycle authority and fresh activation (retained record=%s)',
  async (retained) => {
    const f = await preparedEntryFixture(retained)
    const result = await f.run()
    expect(result.record).toEqual(f.record)
    expect(f.remote.commit).toHaveBeenCalledOnce()
    expect(f.activate).toHaveBeenCalledTimes(2)
    expect(f.runtime.bindOutgoingSshPtyCatalogSurfaces).toHaveBeenCalledOnce()
    expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
    expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
      'profile-installed'
    )
    expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
  }
)

it('preserves the prepared profile when a provider generation changes during activation', async () => {
  const f = await preparedEntryFixture()
  const before = readDataFile()
  const activate = f.activate.getMockImplementation()!
  f.activate.mockImplementationOnce(async (args) => {
    const result = await activate(args)
    f.provider.providerGeneration++
    return result
  })
  await expect(f.run()).rejects.toThrow('source_authority_changed')
  expect(readDataFile()).toEqual(before)
  expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe('prepared')
  expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
})

registerLiveProfileFlushAuthorityTests(preparedEntryFixture)
registerLiveCompletionLifecycleTests(controlReleaseFixture)
