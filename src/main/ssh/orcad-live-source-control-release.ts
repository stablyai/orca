import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { bindOutgoingOrcadIncumbent } from './orcad-outgoing-source-binding'
import { installOrcadLiveProfileUnderAuthority } from './orcad-live-profile-installation'
import {
  OrcadLiveSourceRetirementRecordStore,
  parseOrcadLiveSourceRetirementRecord
} from './orcad-live-source-retirement-record'
import { inspectOrcadLiveCatalogActivationCohort } from './orcad-live-destination-activation'
import {
  assertOrcadLiveSourceReleaseCompatible,
  parseOrcadLiveSourceReleaseIntent
} from './orcad-live-source-release-intent'
import type {
  readRemoteOrcadMigrationCatalogState,
  commitRemoteOrcadMigrationCatalog
} from './orcad-migration-catalog-client'
import { reconfirmOrcadLiveCleanupDestination } from './orcad-live-cleanup-destination-authority'
import { withOrcadCommittedProfileAuthority } from './orcad-committed-profile-authority'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { inspectOrcadLiveSourceOutputSettlements } from './orcad-live-source-output-settlement'
import { fenceOutgoingPtyRegistrations } from '../runtime/outgoing-pty-registration-fence'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'

export async function releaseOrcadLiveSourceControls(
  options: Omit<
    Parameters<typeof releaseOrcadLiveSourceControlsUnderAuthority>[0],
    'record' | 'pairingCode' | 'assertAuthority'
  > & { migrationId: string }
) {
  return withOrcadCommittedProfileAuthority(options, async (authority) => {
    const recovery = inspectOrcadLiveRetirementRecovery(
      options.profileDirectory,
      options.store
    ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
    if (recovery?.state !== 'profile-installed') {
      throw new Error('orcad_live_control_release_installed_profile_required')
    }
    return releaseOrcadLiveSourceControlsUnderAuthority({
      ...options,
      ...authority,
      record: recovery.record
    })
  })
}

/** Settles controls and inspects local output; not a durable route-release acknowledgment. */
export async function releaseOrcadLiveSourceControlsUnderAuthority(options: {
  profileDirectory: string
  store: Store
  record: unknown
  runtime: Pick<
    OrcaRuntimeService,
    'bindOutgoingSshPtyCatalogSurfaces' | 'settleOutgoingSshPtyCatalogModels'
  >
  signal: AbortSignal
  assertAuthority: () => void
  pairingCode: string
  activate?: Parameters<typeof inspectOrcadLiveCatalogActivationCohort>[0]['activate']
  remote?: {
    read: typeof readRemoteOrcadMigrationCatalogState
    commit: typeof commitRemoteOrcadMigrationCatalog
  }
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const { cutover } = record.release
  const evidence = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
  const assertProfile = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    if (
      serializeOrcadMigrationValue(evidence.read(record.identity)) !==
      serializeOrcadMigrationValue(record)
    ) {
      throw new Error('orcad_live_control_release_evidence_changed')
    }
    const profile = options.store.inspectOrcadLiveRetirementProfileState(record)
    if (profile.state !== 'profile-installed') {
      throw new Error('orcad_live_control_release_installed_profile_required', {
        cause:
          profile.state === 'conflict' ? profile.diagnostic : { reason: 'profile-not-installed' }
      })
    }
  }
  assertProfile()
  await installOrcadLiveProfileUnderAuthority({
    ...options,
    record,
    assertAuthority: assertProfile
  })
  const targetId = cutover.manifest.source.sshTargetId
  const inventory = options.runtime.bindOutgoingSshPtyCatalogSurfaces(targetId)
  const bindings = cutover.liveTerminalBindings!
  const expected = bindings.map(({ identity, surfaceBinding }) => ({
    ptyId: toAppSshPtyId(targetId, identity.terminalId),
    incarnationId: identity.incarnationId,
    surfaceBinding
  }))
  const expectedByPty = new Map(
    expected.map((surface) => [surface.ptyId, serializeOrcadMigrationValue(surface)])
  )
  if (
    inventory.surfaces.length !== expectedByPty.size ||
    new Set(inventory.surfaces.map((surface) => surface.ptyId)).size !== expectedByPty.size ||
    inventory.surfaces.some(
      (surface) => expectedByPty.get(surface.ptyId) !== serializeOrcadMigrationValue(surface)
    )
  ) {
    throw new Error('orcad_live_control_release_inventory_mismatch')
  }
  const sources = bindings.map(({ identity, surfaceBinding }) => {
    const source = bindOutgoingOrcadIncumbent({
      identity,
      ptyId: toAppSshPtyId(targetId, identity.terminalId),
      sourceSshTargetId: targetId,
      signal: options.signal,
      assertAuthority: assertProfile
    })
    const release = source.provider.releaseOutgoingSourceControl?.bind(source.provider)
    const drain = source.provider.drainOutgoingSourceControls?.bind(source.provider)
    if (!release || !drain || !source.provider.isOutgoingSourceControlReleased) {
      throw new Error('orcad_live_control_release_provider_unsupported')
    }
    return { source, release, drain, surfaceBinding }
  })
  const assertCurrent = () => {
    assertProfile()
    inventory.assertCurrent()
    for (const { source } of sources) {
      source.assertIncumbent()
    }
  }
  await reconfirmOrcadLiveCleanupDestination({
    ...options,
    cutover,
    destinationRuntimeId: record.identity.destinationRuntimeId,
    assertCurrent
  })
  const current = await inspectOrcadLiveCatalogActivationCohort({
    ...options,
    cutover,
    assertCurrent
  })
  assertOrcadLiveSourceReleaseCompatible(
    parseOrcadLiveSourceReleaseIntent({ version: 1, ...current }),
    record.release
  )
  assertCurrent()
  for (const { source, release } of sources) {
    assertCurrent()
    release({ identity: source.identity, providerGeneration: source.providerGeneration })
  }
  for (const { source, drain, surfaceBinding } of sources) {
    assertCurrent()
    await drain({
      identity: source.identity,
      providerGeneration: source.providerGeneration,
      surfaceBinding,
      signal: options.signal
    })
    assertCurrent()
  }
  assertCurrent()
  if (
    sources.some(({ source }) => !source.provider.isOutgoingSourceControlReleased!(source.ptyId))
  ) {
    throw new Error('orcad_live_control_release_unconfirmed')
  }
  const models = await options.runtime.settleOutgoingSshPtyCatalogModels(targetId, options.signal)
  assertCurrent()
  models.assertCurrent()
  const sourceOutputSettlements = inspectOrcadLiveSourceOutputSettlements(
    sources.map(({ source }) => source),
    () => {
      assertCurrent()
      models.assertCurrent()
    }
  )
  const assertSettled = () => {
    assertCurrent()
    models.assertCurrent()
    const observed = inspectOrcadLiveSourceOutputSettlements(
      sources.map(({ source }) => source),
      () => {
        assertCurrent()
        models.assertCurrent()
      }
    )
    if (
      serializeOrcadMigrationValue(observed) !==
      serializeOrcadMigrationValue(sourceOutputSettlements)
    ) {
      throw new Error('orcad_live_source_output_changed')
    }
  }
  const final = await inspectOrcadLiveCatalogActivationCohort({
    ...options,
    cutover,
    assertCurrent: assertSettled
  })
  assertSettled()
  if (
    serializeOrcadMigrationValue(final.activations) !==
    serializeOrcadMigrationValue(current.activations)
  ) {
    throw new Error('orcad_live_control_release_activation_changed')
  }
  const cleanupIntent = new OrcadLiveSourceCleanupIntentStore(options.profileDirectory).persist(
    createOrcadLiveSourceCleanupIntent(record)
  )
  assertSettled()
  fenceOutgoingPtyRegistrations(
    options.runtime,
    sources.map(({ source }) => source.ptyId)
  )
  return { record, activations: final.activations, sourceOutputSettlements, cleanupIntent }
}
