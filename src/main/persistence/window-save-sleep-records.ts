// A window save in a build where the window still writes the session's resume records: main alone
// writes and resumes a workspace sleep's records, so the save keeps main's and drops the window's.

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

/**
 * The window never writes or clears a workspace sleep's records: a full save that omits the field
 * and a patch that names it, even as undefined, both keep main's. A patch that omits it is left be.
 */
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
