// Forgets the host-private resume records that named a Vault transcript the
// user just deleted; without this the session stays resumable after the UI says
// it is gone. Unlike the resume resolvers (which must pick ONE owner), deletion
// forgets ALL correlated owners — the transcript is gone for each of them.

import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  canonicalAgentSessionTranscriptIdentity,
  transcriptPathConflictsWithWslTarget
} from './agent-session-transcript-identity'
import {
  targetMatchesDiscoveredHost,
  type VaultSnapshotScanIdentity
} from './agent-session-vault-target-index'
import type { AgentSessionRecordStore, HostSessionLaunchRecord } from './agent-session-record-store'

export function forgetDeletedVaultSessionRecords(
  store: AgentSessionRecordStore,
  identity: VaultSnapshotScanIdentity
): number {
  let forgotten = 0
  for (const record of store.durableState().records) {
    if (!isRecordForDeletedTranscript(record, identity)) {
      continue
    }
    const owner = {
      worktreeId: record.worktreeId,
      baseAgent: record.baseAgent,
      providerSessionId: record.providerSession.id
    }
    if (store.forget(owner)) {
      forgotten += 1
    }
  }
  return forgotten
}

function isRecordForDeletedTranscript(
  record: HostSessionLaunchRecord,
  identity: VaultSnapshotScanIdentity
): boolean {
  if (record.baseAgent !== identity.baseAgent) {
    return false
  }
  const target = record.launchSnapshot?.target
  if (!target) {
    // Snapshotless (legacy handoff / migration window): no target attribution,
    // only the recorded connection owner. A remote-owned record's transcript
    // lives on its own host, so a local delete must leave it resumable.
    return (
      identity.scannedExecutionHostId === LOCAL_EXECUTION_HOST_ID &&
      !record.legacyConnectionId &&
      record.providerSession.id === identity.scannedProviderSessionId
    )
  }
  if (!targetMatchesDiscoveredHost(target.executionHostId, identity.scannedExecutionHostId)) {
    return false
  }
  // A UNC path for another distro canonicalizes to null and would fall through
  // to the provider-id match below, so reject the cross-distro case outright.
  if (
    identity.scannedTranscriptPath &&
    transcriptPathConflictsWithWslTarget(identity.scannedTranscriptPath, target.executionHostId)
  ) {
    return false
  }
  const scannedIdentity = identity.scannedTranscriptPath
    ? canonicalAgentSessionTranscriptIdentity({
        transcriptPath: identity.scannedTranscriptPath,
        targetExecutionHostId: target.executionHostId,
        targetPlatform: target.platform
      })
    : null
  const recordIdentity = record.providerSession.transcriptPath
    ? canonicalAgentSessionTranscriptIdentity({
        transcriptPath: record.providerSession.transcriptPath,
        targetExecutionHostId: target.executionHostId,
        targetPlatform: target.platform
      })
    : null
  // A transcript-identity match binds hardest (the scanner's file id can differ
  // from the hook's session id); a known DIFFERENT transcript proves a repeated
  // provider id is not this row.
  if (scannedIdentity && recordIdentity) {
    return scannedIdentity === recordIdentity
  }
  return record.providerSession.id === identity.scannedProviderSessionId
}
