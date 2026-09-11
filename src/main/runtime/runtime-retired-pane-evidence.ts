import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

/**
 * The hook-row identity a pane carried when the host proved its terminal replaced an older one.
 *
 * A hook row names its pane, never its incarnation, so ingestion order is the only discriminator
 * available: a row that already existed when the replacement was proven belongs to the pane's
 * earlier life and can never be the successor's own evidence. A successor's own event is always
 * ingested after the proof that created its incarnation, so it carries a different `receivedAt`
 * and is never matched here — which is what keeps this rule from hiding live successor state.
 */
export type RetiredPaneEvidence = {
  /** Ingestion stamp of the retired row instance. */
  receivedAt: number
  /** Resume identity of the retired row, when it had one. */
  providerSessionId: string | null
  /** Agent claim of the retired row, when it had one. */
  agentType: string | null
}

export function retiredPaneEvidenceFromRow(
  row: AgentStatusIpcPayload | undefined
): RetiredPaneEvidence | null {
  if (!row) {
    return null
  }
  return {
    receivedAt: row.receivedAt,
    providerSessionId: row.providerSession?.id ?? null,
    agentType: row.agentType ?? null
  }
}

export function isRetiredPaneEvidenceRow(
  row: AgentStatusIpcPayload,
  evidence: RetiredPaneEvidence
): boolean {
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
