import type { PersistedState } from '../../../shared/persisted-state-types'
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
    // Why: salvage repairs only the in-memory session; without a save the corrupt entries stay on disk and get re-dropped every launch.
    markNeedsSave()
  }
  return { ...defaults.workspaceSession, ...result.value }
}

export function normalizeLoadedHostSessions(
  parsed: PersistedState,
  defaults: PersistedState,
  markNeedsSave: () => void
): PersistedState['workspaceSessionsByHostId'] {
  const { partitions, repaired } = parseWorkspaceSessionsByHostId(
    parsed.workspaceSessionsByHostId,
    defaults.workspaceSession
  )
  if (repaired) {
    // Why: salvage repairs only the in-memory partitions; without a save the corrupt entries stay on disk and get re-dropped every launch.
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
  // Why: nothing else marks dirty, so an oversized legacy file would otherwise only shrink at the next unrelated save.
  if (runs.length !== parsed.automationRuns.length) {
    markNeedsSave()
  }
  return runs
}
