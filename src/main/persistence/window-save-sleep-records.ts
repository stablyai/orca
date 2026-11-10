// Legacy renderer saves may author other resume state; workspace-sleep records remain main-owned.

import type { OwnedPaneAgentRecord } from '../../shared/agent-session/lifecycle/agent-session-resume'
import { isExplicitPaneSleepRecord } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

type Records = Record<string, OwnedPaneAgentRecord>

function withMainSleepRecords(stored: Records | undefined, saved: Records): Records {
  const kept = Object.entries(saved).filter(([, record]) => !isExplicitPaneSleepRecord(record))
  const main = Object.entries(stored ?? {}).filter(([, record]) =>
    isExplicitPaneSleepRecord(record)
  )
  return Object.fromEntries([...kept, ...main])
}

/** Preserve main-owned sleep records even through omission/undefined; unrelated patches remain untouched. */
export function windowSaveKeepingMainSleepRecords<
  T extends WorkspaceSessionState | WorkspaceSessionPatch
>(stored: WorkspaceSessionState, save: T, kind: 'set' | 'patch'): T {
  if (kind === 'patch' && !Object.hasOwn(save, 'sleepingAgentSessionsByPaneKey')) {
    return save
  }
  const merged = withMainSleepRecords(
    stored.sleepingAgentSessionsByPaneKey,
    save.sleepingAgentSessionsByPaneKey ?? {}
  )
  return {
    ...save,
    sleepingAgentSessionsByPaneKey: Object.keys(merged).length > 0 ? merged : undefined
  }
}
