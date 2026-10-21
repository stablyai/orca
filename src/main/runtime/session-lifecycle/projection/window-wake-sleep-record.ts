import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

/** A running agent's sleep record, which the window's worktree wake relaunches in a fresh tab. */
export function isWindowWakeSleepRecord(record: SleepingAgentSessionRecord): boolean {
  return record.origin === 'worktree-sleep' && record.state !== 'done'
}

/** The host's own pane-owned capture form (#11598), which no window wake relaunches. */
function paneOwnedForm(record: SleepingAgentSessionRecord): SleepingAgentSessionRecord {
  return { ...record, state: 'done', restoreOnTabOpenOnly: true }
}

function sameRecord(a: SleepingAgentSessionRecord, b: SleepingAgentSessionRecord): boolean {
  return (
    a.origin === b.origin &&
    a.state === b.state &&
    a.capturedAt === b.capturedAt &&
    a.agent === b.agent &&
    agentProviderSessionsEqual(a.agent, a.providerSession, b.providerSession)
  )
}

type SessionEdit = (
  edit: (session: WorkspaceSessionState) => WorkspaceSessionState | null
) => Promise<void>

/**
 * Durably hands a window-wake record to the pane about to resume it, before the spawn, unless a
 * window now owns its wake: a window attaching mid-spawn then cannot relaunch it as a second writer,
 * and a PTY lost later (or a failed spawn) still resumes the pane with its recorded flags on the
 * next open. False when nothing was claimed; the pane then opens a plain shell.
 */
export async function claimWindowWakeRecordForPane(
  commit: SessionEdit,
  windowOwnsWake: () => boolean,
  record: SleepingAgentSessionRecord
): Promise<boolean> {
  const claimed = paneOwnedForm(record)
  let owned = false
  try {
    await commit((session) => {
      const stored = session.sleepingAgentSessionsByPaneKey?.[record.paneKey]
      // Why: an overlapping open of this pane claimed it first; resume alongside it, since a plain
      // shell spawned here could win the pane and swallow that open's resume.
      if (stored && sameRecord(stored, claimed)) {
        owned = true
        return null
      }
      if (!stored || !sameRecord(stored, record) || windowOwnsWake()) {
        return null
      }
      owned = true
      return {
        ...session,
        sleepingAgentSessionsByPaneKey: {
          ...session.sleepingAgentSessionsByPaneKey,
          [record.paneKey]: claimed
        }
      }
    })
  } catch {
    return false
  }
  return owned
}
