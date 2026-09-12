import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { normalizeSshPtyConsumerRecovery } from '../persistence/leasing-ssh-ptys/ssh-normalization'
import { projectOrcadSourceLiveState } from '../persistence/migrating-orcad-catalog/orcad-source-live-state-projection'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import type { retainOrcadLiveSuccessorSession } from './orcad-live-successor-session'

/** Pre-install authority only: installing the candidate deliberately removes saved owner recovery. */
export function bindOrcadLiveSuccessorProfileAdmission(options: {
  record: unknown
  store: Pick<Store, 'getSshRemotePtyLeases' | 'getSshPtyConsumerRecovery'>
  retained: Pick<
    Awaited<ReturnType<typeof retainOrcadLiveSuccessorSession>>,
    'readSession' | 'assertCurrent'
  >
  signal: AbortSignal
  assertAuthority: () => void
  assertRuntimeAbsent: () => void
  assertCancellation: (record: unknown) => void
}) {
  const { store, retained, signal, assertAuthority, assertRuntimeAbsent, assertCancellation } =
    options
  const record = structuredClone(parseOrcadLiveSourceRetirementRecord(options.record))
  const cutover = record.release.cutover
  const targetId = cutover.manifest.source.sshTargetId
  const bindings = structuredClone(cutover.liveTerminalBindings!)
  const serialized = serializeOrcadMigrationValue
  const assertOuter = () => {
    signal.throwIfAborted()
    assertAuthority()
    assertRuntimeAbsent()
    assertCancellation(structuredClone(record))
    retained.assertCurrent()
  }
  assertOuter()
  const session = retained.readSession()
  const owner = normalizeSshPtyConsumerRecovery(store.getSshPtyConsumerRecovery(targetId))
  if (
    !session?.resumed ||
    session.targetId !== targetId ||
    session.owner.mode !== 'negotiated' ||
    !owner ||
    owner.targetId !== targetId ||
    !bindings.length ||
    bindings.some(
      ({ identity }) =>
        identity.ownerLease !== owner.ownerLease ||
        identity.sourceOwnerGeneration >= owner.ownerGeneration
    )
  ) {
    throw new Error('orcad_live_successor_profile_owner_required')
  }
  const { targetId: _targetId, serverBuildId: _build, ...claim } = owner
  const expectedOwner = serialized({ mode: 'negotiated', ...claim })
  const recoveryEvidence = serialized(owner)
  const leases = structuredClone(store.getSshRemotePtyLeases(targetId))
  const leaseEvidence = serialized(leases)
  const { mux, connection, transportGeneration } = session
  const assertCurrent = () => {
    assertOuter()
    const current = retained.readSession()
    if (
      !current?.resumed ||
      current.targetId !== targetId ||
      current.mux !== mux ||
      mux.isDisposed() ||
      current.connection !== connection ||
      current.transportGeneration !== transportGeneration ||
      serialized(current.owner) !== expectedOwner ||
      serialized(store.getSshPtyConsumerRecovery(targetId)) !== recoveryEvidence ||
      serialized(store.getSshRemotePtyLeases(targetId)) !== leaseEvidence
    ) {
      throw new Error('orcad_live_successor_profile_evidence_changed')
    }
  }
  assertCurrent()
  return {
    owner: Object.freeze({
      ...owner,
      ...(owner.outputFlowControl
        ? { outputFlowControl: Object.freeze({ ...owner.outputFlowControl }) }
        : {})
    }),
    assertCurrent,
    assertCancellation(value: unknown) {
      assertCurrent()
      if (serialized(parseOrcadLiveSourceRetirementRecord(value)) !== serialized(record)) {
        throw new Error('orcad_live_successor_profile_record_changed')
      }
    },
    assertBindings(value: unknown) {
      assertCurrent()
      if (serialized(value) !== serialized(bindings)) {
        throw new Error('orcad_live_successor_profile_bindings_changed')
      }
    },
    projectSourceState(
      state: Parameters<typeof projectOrcadSourceLiveState>[0],
      source: Parameters<typeof projectOrcadSourceLiveState>[1],
      catalog: Parameters<typeof projectOrcadSourceLiveState>[2]
    ) {
      assertCurrent()
      if (
        serialized(source) !== serialized(cutover.manifest.source) ||
        serialized(catalog) !== serialized(cutover.manifest.payload)
      ) {
        throw new Error('orcad_live_successor_profile_source_changed')
      }
      const candidate = projectOrcadSourceLiveState(state, source, catalog, {
        bindings,
        leases,
        recovery: owner
      })
      assertCurrent()
      return candidate
    }
  }
}
