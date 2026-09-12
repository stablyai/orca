import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

/**
 * The hook-row identity a pane carried when the host proved its terminal replaced an older one.
 *
 * A hook row names its pane, never its incarnation, so the row's own observation is the exact
 * discriminator: main's revision counter is strictly increasing per authority, so a successor's
 * own row can never reuse the retired row's revision. The timestamp composite stays as the
 * fallback for rows main never stamped (persisted rehydration, old hosts) — on its own it cannot
 * tell two rows apart that share one millisecond, the same provider session and the same agent,
 * which would hide a resumed successor's live status.
 *
 * A successor's own event is always ingested after the proof that created its incarnation, so it
 * carries a different observation and is never matched here — which is what keeps this rule from
 * hiding live successor state.
 */
export type RetiredPaneEvidence = {
  /** Ingestion stamp of the retired row instance. */
  receivedAt: number
  /** Resume identity of the retired row, when it had one. */
  providerSessionId: string | null
  /** Agent claim of the retired row, when it had one. */
  agentType: string | null
  /** The retired row instance's own observation, when main stamped one. `revision` is unique per
   *  observation within one authority, so equality means "the same row instance". */
  observation?: { authorityId: string; revision: number }
}

export function retiredPaneEvidenceFromRow(
  row: AgentStatusIpcPayload | undefined
): RetiredPaneEvidence | null {
  if (!row) {
    return null
  }
  const observation = row.observation
  return {
    receivedAt: row.receivedAt,
    providerSessionId: row.providerSession?.id ?? null,
    agentType: row.agentType ?? null,
    ...(observation
      ? { observation: { authorityId: observation.authorityId, revision: observation.revision } }
      : {})
  }
}

export function isRetiredPaneEvidenceRow(
  row: AgentStatusIpcPayload,
  evidence: RetiredPaneEvidence
): boolean {
  const recordedObservation = evidence.observation
  if (recordedObservation && row.observation) {
    return (
      row.observation.authorityId === recordedObservation.authorityId &&
      row.observation.revision === recordedObservation.revision
    )
  }
  return (
    row.receivedAt === evidence.receivedAt &&
    (row.providerSession?.id ?? null) === evidence.providerSessionId &&
    (row.agentType ?? null) === evidence.agentType
  )
}

/** Drops the retired row instance only; every other row the pane holds is left for projection. */
export function excludeRetiredPaneEvidenceRows(
  rows: AgentStatusIpcPayload[],
  evidence: RetiredPaneEvidence | null | undefined
): AgentStatusIpcPayload[] {
  return evidence ? rows.filter((row) => !isRetiredPaneEvidenceRow(row, evidence)) : rows
}

/** Newest row of a pane's rows, i.e. the one a reconcile would retain. */
export function latestAgentStatusRow(
  rows: readonly AgentStatusIpcPayload[]
): AgentStatusIpcPayload | undefined {
  let latest: AgentStatusIpcPayload | undefined
  for (const row of rows) {
    if (!latest || row.receivedAt > latest.receivedAt) {
      latest = row
    }
  }
  return latest
}
