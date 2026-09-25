import {
  getAgentResumeArgv,
  isDurableSleepingCapture,
  type ResumableTuiAgent
} from '../../shared/agent-session-resume'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * A pane whose process has exited and whose resume record can bring it back.
 *
 * Kept out of the execution-host liveness vocabulary on purpose: this says the
 * pane is resumable, never that a process is or is not running on a host
 * (docs/reference/ssh-execution-boundary.md).
 */
export type ResumableSleptPane = {
  paneKey: string
  worktreeId: string
  tabId: string
  leafId: string
  title: string | null
  agent: ResumableTuiAgent
  lastOutputAt: number | null
}

/**
 * Slept panes across every host partition, so a sender surveying agents sees the
 * sleeping ones instead of concluding nothing is there.
 *
 * Only durable captures qualify: an `origin: 'live'` row is the resume anchor a
 * still-running pane keeps after each turn, not a pane that went away.
 */
export function collectResumableSleptPanes(
  sessions: Iterable<WorkspaceSessionState | null | undefined>,
  options: {
    targetWorktreeId: string | null
    matchesTargetWorktree: (worktreeId: string, targetWorktreeId: string) => boolean
  }
): ResumableSleptPane[] {
  const byPaneKey = new Map<string, ResumableSleptPane>()
  for (const session of sessions) {
    for (const record of Object.values(session?.sleepingAgentSessionsByPaneKey ?? {})) {
      const parsed = parsePaneKey(record.paneKey)
      const tabId = record.tabId ?? parsed?.tabId
      if (
        !parsed ||
        !tabId ||
        !isDurableSleepingCapture(record) ||
        !getAgentResumeArgv(record.agent, record.providerSession) ||
        (options.targetWorktreeId !== null &&
          !options.matchesTargetWorktree(record.worktreeId, options.targetWorktreeId))
      ) {
        continue
      }
      byPaneKey.set(record.paneKey, {
        paneKey: record.paneKey,
        worktreeId: record.worktreeId,
        tabId,
        leafId: parsed.leafId,
        title: record.terminalTitle ?? null,
        agent: record.agent,
        lastOutputAt: record.updatedAt
      })
    }
  }
  return [...byPaneKey.values()]
}
