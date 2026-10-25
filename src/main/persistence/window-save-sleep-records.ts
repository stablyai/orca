// Legacy renderer saves may author other resume state; workspace-sleep records remain main-owned.

import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { isWorkspaceSleepRecord } from '../../shared/workspace-sleep'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

type Records = Record<string, SleepingAgentSessionRecord>

function withMainSleepRecords(stored: Records | undefined, saved: Records): Records {
  const kept = Object.entries(saved).filter(([, record]) => !isWorkspaceSleepRecord(record))
  const main = Object.entries(stored ?? {}).filter(([, record]) => isWorkspaceSleepRecord(record))
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
