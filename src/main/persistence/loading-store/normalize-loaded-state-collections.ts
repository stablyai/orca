import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  normalizeProjectHostSetupRows,
  normalizeProjectRows
} from '../../../shared/project-catalog-row-normalization'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseWorkspaceSessionSalvaging } from '../../../shared/workspace-session-salvage'
import {
  backfillAutomationRunNumbers,
  pruneAutomationRuns
} from '../../../shared/automation-run-retention'
import {
  parseWorkspaceSessionsByHostId,
  workspaceSessionSalvageLogDetails
} from './workspace-session-partitions'

export function normalizeLoadedLocalSession(
  parsed: PersistedState,
  defaults: PersistedState,
  markNeedsSave: () => void
): WorkspaceSessionState {
  if (parsed.workspaceSession === undefined) {
    return defaults.workspaceSession
  }
  const result = parseWorkspaceSessionSalvaging(parsed.workspaceSession)
  if (!result.ok) {
    console.error('[persistence] Corrupt workspace session, using defaults:', result.error)
    return defaults.workspaceSession
  }
  if (result.droppedCount > 0) {
    console.warn(
      '[persistence] Salvaged workspace session; dropped corrupt entries:',
      workspaceSessionSalvageLogDetails(result)
    )
    // Persist salvaged state so corrupt entries do not recur on every launch.
    markNeedsSave()
  }
  return { ...defaults.workspaceSession, ...result.value }
}

export function normalizeLoadedHostSessions(
  parsed: PersistedState,
  defaults: PersistedState,
  localSession: WorkspaceSessionState,
  markNeedsSave: () => void
): PersistedState['workspaceSessionsByHostId'] {
  const { partitions, repaired } = parseWorkspaceSessionsByHostId(
    parsed.workspaceSessionsByHostId,
    defaults.workspaceSession,
    localSession
  )
  if (repaired) {
    markNeedsSave()
  }
  return partitions
}

export function normalizeLoadedAutomationRuns(
  parsed: PersistedState,
  markNeedsSave: () => void
): PersistedState['automationRuns'] {
  if (!Array.isArray(parsed.automationRuns)) {
    return []
  }
  const runs = pruneAutomationRuns(backfillAutomationRunNumbers(parsed.automationRuns))
  // Persist pruning even when no unrelated save follows startup.
  if (runs.length !== parsed.automationRuns.length) {
    markNeedsSave()
  }
  return runs
}

/** Repair untrusted catalog fields and persist them before republishing to paired clients. */
export function normalizeLoadedProjectCatalog(
  parsed: Partial<Pick<PersistedState, 'projects' | 'projectHostSetups'>>,
  markNeedsSave: () => void
): Pick<PersistedState, 'projects' | 'projectHostSetups'> {
  const projects = normalizeProjectRows(parsed.projects ?? [])
  const projectHostSetups = normalizeProjectHostSetupRows(parsed.projectHostSetups ?? [])
  if (projects !== parsed.projects || projectHostSetups !== parsed.projectHostSetups) {
    markNeedsSave()
  }
  return { projects, projectHostSetups }
}
