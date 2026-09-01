import type { TuiAgent } from '../../../src/shared/types'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import {
  buildMobileAgentPickerRows,
  type MobileAgentPickerRow
} from './mobile-agent-catalog-projection'
import {
  isWorkspaceAgentEnabled,
  type WorkspaceCustomAgentBases
} from './workspace-agent-selection'

export type TaskWorkspaceAgentCatalog = {
  rows: MobileAgentPickerRow[]
  customAgentBases: WorkspaceCustomAgentBases
  customAgentLabels: ReadonlyMap<TuiAgent, string>
}

export function buildTaskWorkspaceAgentCatalog(
  snapshot: AgentCatalogValue | null,
  detectedAgentIds: Set<string> | null,
  disabledTuiAgents?: unknown
): TaskWorkspaceAgentCatalog {
  const rows = buildMobileAgentPickerRows(snapshot, { includeCustomAgents: true }).filter((row) => {
    const detectedId = row.isCustom ? row.baseAgent : row.id
    return (
      detectedId !== undefined &&
      (row.isCustom || isWorkspaceAgentEnabled(row.id, disabledTuiAgents)) &&
      (detectedAgentIds === null || detectedAgentIds.has(detectedId))
    )
  })
  const customAgentBases = new Map<TuiAgent, NonNullable<MobileAgentPickerRow['baseAgent']>>()
  const customAgentLabels = new Map<TuiAgent, string>()
  for (const row of rows) {
    if (row.isCustom && row.baseAgent) {
      customAgentBases.set(row.id, row.baseAgent)
      customAgentLabels.set(row.id, row.label)
    }
  }
  return { rows, customAgentBases, customAgentLabels }
}
