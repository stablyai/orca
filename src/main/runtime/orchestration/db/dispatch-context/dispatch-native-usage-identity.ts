import type { OrchestrationDb } from '../orchestration-db'
import type {
  NativeTranscriptFileIdentity,
  NativeUsageIntervalUnavailableReason
} from '../../workers/transcripts/native-usage-interval-scan'

export type NativeUsageIntervalState =
  | {
      status: 'open'
      transcriptPath: string
      /** Identity of the transcript when the session was first observed; null if not yet created. */
      startFile: NativeTranscriptFileIdentity | null
      notBeforeMs: number
    }
  | {
      status: 'closed'
      transcriptPath: string
      file: NativeTranscriptFileIdentity
      startOffset: 0
      endOffset: number
      sha256: string
      closedAt: number
    }
  | { status: 'unavailable'; reason: NativeUsageIntervalUnavailableReason }

export type DispatchNativeUsageIdentityReceipt = {
  status: 'observed'
  agent: string
  sessionId: string
  paneKey: string
  processIncarnation: string
  hostScope: string
  launchTokenHash: string
  observedAt: number
  interval?: NativeUsageIntervalState
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
        observedAt: receipt.observedAt,
        ...(receipt.interval ? { interval: receipt.interval } : {})
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

/** True when another Dispatch already holds this native session, so no interval can be exclusive. */
export function nativeSessionHeldByOtherDispatch(
  db: OrchestrationDb,
  dispatchId: string,
  agent: string,
  sessionId: string
): boolean {
  const row = db.db
    .prepare(`SELECT 1 AS held FROM dispatch_contexts
      WHERE id != ? AND json_valid(native_usage_identity)
        AND json_extract(native_usage_identity, '$.agent') = ?
        AND json_extract(native_usage_identity, '$.sessionId') = ? LIMIT 1`)
    .get(dispatchId, agent, sessionId)
  return row !== undefined
}

/** Read the observed identity and its open interval, if any. */
export function readOpenNativeUsageInterval(
  db: OrchestrationDb,
  dispatchId: string
): { agent: string; sessionId: string; interval: NativeUsageIntervalState | null } | null {
  const raw = db.getDispatchContextById(dispatchId)?.native_usage_identity
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === 'object' &&
      'status' in value &&
      value.status === 'observed' &&
      'agent' in value &&
      typeof value.agent === 'string' &&
      'sessionId' in value &&
      typeof value.sessionId === 'string'
    ) {
      // The interval was written by this module as NativeUsageIntervalState.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: persisted by this module; exposure re-validates.
      const interval = (
        'interval' in value ? value.interval : null
      ) as NativeUsageIntervalState | null
      return { agent: value.agent, sessionId: value.sessionId, interval }
    }
  } catch {
    // Malformed evidence has no interval.
  }
  return null
}

/** Settle an open interval once; later reports (replays, repeated releases) keep the first outcome. */
export function settleDispatchNativeUsageInterval(
  db: OrchestrationDb,
  dispatchId: string,
  outcome: Exclude<NativeUsageIntervalState, { status: 'open' }>
): boolean {
  const before = db.getDispatchContextById(dispatchId)?.native_usage_identity
  if (typeof before !== 'string') {
    return false
  }
  let identity: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(before)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    identity = { ...parsed }
  } catch {
    return false
  }
  if (identity.status !== 'observed') {
    return false
  }
  const current = identity.interval
  const open =
    current && typeof current === 'object' && 'status' in current && current.status === 'open'
  if (current !== undefined && !open) {
    return false
  }
  identity.interval =
    current === undefined ? { status: 'unavailable', reason: 'start_boundary_missing' } : outcome
  const result = db.db
    .prepare(
      'UPDATE dispatch_contexts SET native_usage_identity = ? WHERE id = ? AND native_usage_identity = ?'
    )
    .run(JSON.stringify(identity), dispatchId, before)
  return Number(result.changes) > 0
}
