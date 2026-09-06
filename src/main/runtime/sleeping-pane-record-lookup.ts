import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { isEquivalentPaneKey } from './orchestration/db/pane-key-match'

/**
 * The resume record for a pane whose process is gone, searched across every host
 * partition. Why all of them: a pane key carries no host, and a slept pane on an
 * SSH-worktree keeps its own partition (#12723), so reading only 'local' reports
 * a remote slept pane as never having existed.
 */
export function findSleepingAgentSessionRecord(
  sessions: Iterable<WorkspaceSessionState | null | undefined>,
  paneKey: string
): SleepingAgentSessionRecord | undefined {
  for (const session of sessions) {
    const byPaneKey = session?.sleepingAgentSessionsByPaneKey
    if (!byPaneKey) {
      continue
    }
    const exact = byPaneKey[paneKey]
    if (exact) {
      return exact
    }
    for (const [candidateKey, record] of Object.entries(byPaneKey)) {
      if (isEquivalentPaneKey(candidateKey, paneKey)) {
        return record
      }
    }
  }
  return undefined
}
