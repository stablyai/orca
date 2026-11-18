import type { OrchestrationDb } from '../orchestration-db'

export type DispatchNativeUsageIdentityReceipt = {
  status: 'observed'
  agent: string
  sessionId: string
  paneKey: string
  processIncarnation: string
  hostScope: string
  launchTokenHash: string
  observedAt: number
}

/** Record an observation only while its complete Dispatch authority is still current. */
export function recordDispatchNativeUsageIdentity(
  db: OrchestrationDb,
  dispatchId: string,
  receipt: DispatchNativeUsageIdentityReceipt
): boolean {
  if (
    typeof dispatchId !== 'string' ||
    !dispatchId.trim() ||
    !receipt ||
    receipt.status !== 'observed' ||
    ![
      receipt.agent,
      receipt.sessionId,
      receipt.paneKey,
      receipt.processIncarnation,
      receipt.hostScope,
      receipt.launchTokenHash
    ].every((value) => typeof value === 'string' && value.trim().length > 0) ||
    typeof receipt.observedAt !== 'number' ||
    !Number.isFinite(receipt.observedAt)
  ) {
    return false
  }

  // A single conditional UPDATE serializes competing observations and authority changes. The
  // timestamp is deliberately excluded from identity: repeat reports preserve the first receipt.
  const result = db.db
    .prepare(`
    UPDATE dispatch_contexts SET native_usage_identity = CASE
      WHEN native_usage_identity IS NULL THEN ?
      WHEN json_valid(native_usage_identity) THEN CASE
        WHEN json_extract(native_usage_identity, '$.status') = 'unavailable'
          THEN native_usage_identity
        WHEN json_extract(native_usage_identity, '$.status') = 'observed'
          AND json_extract(native_usage_identity, '$.agent') = ?
          AND json_extract(native_usage_identity, '$.sessionId') = ?
          AND json_extract(native_usage_identity, '$.paneKey') = ?
          AND json_extract(native_usage_identity, '$.processIncarnation') = ?
          AND json_extract(native_usage_identity, '$.hostScope') = ?
          AND json_extract(native_usage_identity, '$.launchTokenHash') = ?
          THEN native_usage_identity
        ELSE ? END
      ELSE ? END
    WHERE id = ? AND capability_revoked_at IS NULL
      AND assignee_pane_key = ? AND process_incarnation = ?
      AND host_scope = ? AND launch_token_hash = ?
  `)
    .run(
      JSON.stringify({
        status: receipt.status,
        agent: receipt.agent,
        sessionId: receipt.sessionId,
        paneKey: receipt.paneKey,
        processIncarnation: receipt.processIncarnation,
        hostScope: receipt.hostScope,
        launchTokenHash: receipt.launchTokenHash,
        observedAt: receipt.observedAt
      }),
      receipt.agent,
      receipt.sessionId,
      receipt.paneKey,
      receipt.processIncarnation,
      receipt.hostScope,
      receipt.launchTokenHash,
      JSON.stringify({ status: 'unavailable', reason: 'session_changed_or_shared' }),
      JSON.stringify({ status: 'unavailable', reason: 'session_changed_or_shared' }),
      dispatchId,
      receipt.paneKey,
      receipt.processIncarnation,
      receipt.hostScope,
      receipt.launchTokenHash
    )
  return Number(result.changes) > 0
}
