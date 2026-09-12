import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { fenceOutgoingPtyRegistrations } from '../runtime/outgoing-pty-registration-fence'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { bindOrcadLiveAppliedCoverageEvidence } from './orcad-live-applied-coverage-evidence'
import { bindOrcadLiveSuccessorControlAbsence } from './orcad-live-successor-control-absence'
import { getSshConnectionManager } from './ssh-target-registry'
import { portForwardManager } from '../ipc/ssh-ipc-context'
import { removeSshPortForwardsForTarget } from './ssh-port-forward-target-cleanup'

type Runtime = Pick<OrcaRuntimeService, 'bindOutgoingSshPtySurfaceAbsence'> &
  Partial<Pick<OrcaRuntimeService, 'prepareOutgoingSshPtyGraphAndModelCleanup'>>
type Prepared = {
  evidence: string
  cleanup: ReturnType<OrcaRuntimeService['prepareOutgoingSshPtyGraphAndModelCleanup']>
}
const preparedByRuntime = new WeakMap<object, Map<string, Prepared>>()

/** Applied destination output authorizes local model disposal, never remote process termination. */
export async function cleanupOrcadLiveSuccessorRuntime(options: {
  profileDirectory: string
  record: unknown
  runtime: Runtime
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const targetId = record.release.cutover.manifest.source.sshTargetId
  const surfaces = record.release.cutover.liveTerminalBindings!.map(
    ({ identity, surfaceBinding }) => ({
      ptyId: toAppSshPtyId(targetId, identity.terminalId),
      incarnationId: identity.incarnationId,
      surfaceBinding
    })
  )
  const applied = bindOrcadLiveAppliedCoverageEvidence(options.profileDirectory, record)
  const assertEvidence = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    applied.assertCurrent()
  }
  assertEvidence()
  fenceOutgoingPtyRegistrations(
    options.runtime,
    surfaces.map(({ ptyId }) => ptyId)
  )
  const key = record.release.cutover.manifest.migrationId
  const evidence = serializeOrcadMigrationValue({
    profileDirectory: options.profileDirectory,
    record,
    applied: applied.evidence
  })
  let operations = preparedByRuntime.get(options.runtime)
  let prepared = operations?.get(key)
  if (prepared && prepared.evidence !== evidence) {
    throw new Error('orcad_live_successor_runtime_cleanup_evidence_changed')
  }
  if (!prepared) {
    try {
      const absence = options.runtime.bindOutgoingSshPtySurfaceAbsence(targetId, surfaces)
      assertEvidence()
      absence.assertAbsent()
      return absence
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'orcad_outgoing_source_runtime_surfaces_present'
      ) {
        throw error
      }
    }
  }
  const manager = getSshConnectionManager()
  if (!manager || !portForwardManager) {
    throw new Error('orcad_live_successor_control_context_unavailable')
  }
  await manager.disconnectAndDrain(targetId, options.signal)
  await removeSshPortForwardsForTarget(portForwardManager, targetId)
  const controls = bindOrcadLiveSuccessorControlAbsence({
    targetId,
    signal: options.signal,
    assertAuthority: assertEvidence
  })
  const assertCurrent = () => {
    assertEvidence()
    controls.assertAbsent()
    assertEvidence()
  }
  assertCurrent()
  const prepare = options.runtime.prepareOutgoingSshPtyGraphAndModelCleanup
  if (!prepare) {
    throw new Error('orcad_live_successor_runtime_cleanup_unavailable')
  }
  if (!operations) {
    operations = new Map()
    preparedByRuntime.set(options.runtime, operations)
  }
  if (!prepared) {
    prepared = { evidence, cleanup: prepare.call(options.runtime, targetId, surfaces) }
    operations.set(key, prepared)
  }
  assertCurrent()
  await prepared.cleanup.remove(assertCurrent, options.signal)
  assertCurrent()
  const absence = options.runtime.bindOutgoingSshPtySurfaceAbsence(targetId, surfaces)
  absence.assertAbsent()
  assertCurrent()
  operations.delete(key)
  return absence
}
