import type { PersistedState } from '../../../shared/persisted-state-types'
import { inspectOrcadLiveRetirementProfileEvidence } from './orcad-live-retirement-profile-state'
import { hasOrcadLiveRetiredSourceSessionState } from './orcad-live-retired-session-proof'
import { assertSourceCatalogRetired } from './orcad-source-cutover-validation'

/** Session publication cannot reinstall a profile or authorize source route retirement. */
export function hasOrcadRetirementPublicationAuthority(
  state: PersistedState,
  value: unknown
): boolean {
  const evidence = inspectOrcadLiveRetirementProfileEvidence(state, value)
  if (evidence.state === 'conflict' || evidence.marker?.recordSha256 !== evidence.record.sha256) {
    return false
  }
  const { record } = evidence
  const { manifest } = record.release.cutover
  assertSourceCatalogRetired(state, manifest)
  const terminals = new Set(
    record.release.cutover.liveTerminalBindings?.map(({ identity }) => identity.terminalId)
  )
  if (
    state.sshRemotePtyLeases.some(
      (lease) =>
        lease.targetId === manifest.source.sshTargetId &&
        (lease.state !== 'terminated' || terminals.has(lease.ptyId))
    ) ||
    state.sshPtyConsumerRecoveries?.some((row) => row.targetId === manifest.source.sshTargetId)
  ) {
    return false
  }
  return hasOrcadLiveRetiredSourceSessionState(state, record)
}
