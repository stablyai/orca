import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

function sameAgentHookObservation(
  before: AgentStatusIpcPayload,
  after: AgentStatusIpcPayload
): boolean {
  return (
    before.paneKey === after.paneKey &&
    before.terminalHandle === after.terminalHandle &&
    before.launchToken === after.launchToken &&
    before.providerSession?.key === after.providerSession?.key &&
    before.providerSession?.id === after.providerSession?.id &&
    before.receivedAt === after.receivedAt &&
    before.evidenceObservedAt === after.evidenceObservedAt &&
    before.state === after.state &&
    before.observation?.authorityId === after.observation?.authorityId &&
    before.observation?.incarnation === after.observation?.incarnation &&
    before.observation?.revision === after.observation?.revision
  )
}

function readAgentHookRowsForPaneKeys(
  paneKeys: ReadonlySet<string>,
  readRowsForPane: ((paneKey: string) => AgentStatusIpcPayload[]) | undefined,
  readSnapshot: (() => AgentStatusIpcPayload[]) | undefined
): AgentStatusIpcPayload[] {
  if (readRowsForPane) {
    const rows: AgentStatusIpcPayload[] = []
    for (const paneKey of paneKeys) {
      rows.push(...readRowsForPane(paneKey))
    }
    return rows
  }
  return (readSnapshot?.() ?? []).filter((row) => paneKeys.has(row.paneKey))
}

export function captureAgentHookRetirementFence(
  paneKeys: ReadonlySet<string>,
  readRowsForPane: ((paneKey: string) => AgentStatusIpcPayload[]) | undefined,
  readSnapshot: (() => AgentStatusIpcPayload[]) | undefined
): () => boolean {
  const before = readAgentHookRowsForPaneKeys(paneKeys, readRowsForPane, readSnapshot)
  return () => {
    const after = readAgentHookRowsForPaneKeys(paneKeys, readRowsForPane, readSnapshot)
    return (
      before.length === after.length &&
      before.every((row) => after.some((current) => sameAgentHookObservation(row, current)))
    )
  }
}
