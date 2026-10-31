import {
  agentProviderSessionsEqual,
  isPaneSleepRecord,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

/** An older window capture of a still-running agent, which no pane has claimed yet. */
export function isUnclaimedRunningSleepRecord(record: SleepingAgentSessionRecord): boolean {
  return record.origin === 'worktree-sleep' && record.state !== 'done'
}

/** The host's own pane-owned capture form (#11598), which no wake resumes a second time. */
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

/** Claim durably before spawn so failed/lost PTYs retain resume flags. False on failed commit or changed/missing record; callers then open a shell. */
export async function claimSleepRecordForPane(
  commit: SessionEdit,
  record: SleepingAgentSessionRecord
): Promise<boolean> {
  const claimed = paneOwnedForm(record)
  let owned = false
  try {
    await commit((session) => {
      const stored = session.sleepingAgentSessionsByPaneKey?.[record.paneKey]
      // Same-pane overlapping opens resume together; a competing plain shell could win the pane and swallow the resume.
      if (stored && sameRecord(stored, claimed)) {
        owned = true
        return null
      }
      if (!stored || !sameRecord(stored, record)) {
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

/** After main resumes the slept record, mark that same record live for wake display and crash recovery; leave any newer sleep capture intact. */
export async function markResumedRecordLive(
  commit: SessionEdit,
  paneKey: string,
  resumed: SleepingAgentSessionRecord
): Promise<void> {
  await commit((session) => {
    const stored = session.sleepingAgentSessionsByPaneKey?.[paneKey]
    if (!stored || !isPaneSleepRecord(stored) || !sameRecord(stored, resumed)) {
      return null
    }
    return {
      ...session,
      sleepingAgentSessionsByPaneKey: {
        ...session.sleepingAgentSessionsByPaneKey,
        [paneKey]: { ...stored, origin: 'live' }
      }
    }
  })
}
