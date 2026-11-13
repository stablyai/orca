import { mailWakeObligation } from '../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

type Commit = (
  edit: (session: WorkspaceSessionState) => WorkspaceSessionState | null
) => Promise<void>

export async function retainMailWakeAttempt(
  commit: Commit,
  record: SleepingAgentSessionRecord,
  ptyId: string,
  result: RuntimeTerminalCreate
): Promise<void> {
  const marker = record.mailWake
  const incarnationId = result.incarnationId
  const launchToken = result.launchToken
  if (!marker || !incarnationId || !launchToken || result.isReattach) {
    return
  }
  await commit((session) => {
    const current = session.sleepingAgentSessionsByPaneKey?.[record.paneKey]
    if (
      current?.mailWake?.id !== marker.id ||
      current.capturedAt !== record.capturedAt ||
      mailWakeObligation(current) !== 'retained' ||
      current.mailWake.attempt?.launchToken !== marker.attempt?.launchToken
    ) {
      return null
    }
    return {
      ...session,
      sleepingAgentSessionsByPaneKey: {
        ...session.sleepingAgentSessionsByPaneKey,
        [record.paneKey]: {
          ...current,
          origin: 'quit',
          restoreOnTabOpenOnly: true,
          mailWake: {
            ...marker,
            attempt: { ptyId, incarnationId, launchToken, startedAt: marker.startedAt }
          }
        }
      }
    }
  })
}
