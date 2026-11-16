import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { promoteSavedLiveResumeRecord } from '../../../shared/agent-session/lifecycle/resume/promote-saved-live-resume-record'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

export type PaneAgentIdentity = {
  status: AgentStatusIpcPayload
  /** The agent left the pane; its identity names what to retire, not what to resume. */
  ended: boolean
}

/** The one rule for which agent conversation a pane holds: its hook row in any at-rest shape,
 *  else its saved live record, minus an exit recorded since that identity was last updated. */
export function paneAgentIdentity(args: {
  paneKey: string
  row?: AgentStatusIpcPayload
  savedRecord?: SleepingAgentSessionRecord
  worktreeId?: string
  exitedAt?: number
  /** Process evidence that the pane's agent has ended. */
  ended?: boolean
}): PaneAgentIdentity | null {
  const { row } = args
  if (row) {
    // Structured chats own their sessions elsewhere; a row of any other agent here outranks the record.
    if (row.structuredHost) {
      return null
    }
    // Resume-only rows carry placeholder status; read them as at rest without claiming a finished turn.
    const {
      workingMode: _workingMode,
      providerSessionOnly: _providerSessionOnly,
      ...placeholder
    } = row
    const status: AgentStatusIpcPayload = row.providerSessionOnly
      ? { ...placeholder, state: 'done' }
      : row
    // Sleep is a resumable physical stop: its exit retires the process, never the conversation.
    if (row.paneSleep) {
      return { status, ended: false }
    }
    return { status, ended: endedSince(args, row.receivedAt) }
  }
  const saved = args.savedRecord
  const promoted =
    saved && args.worktreeId
      ? promoteSavedLiveResumeRecord({
          record: saved,
          worktreeId: args.worktreeId,
          capturedAt: saved.capturedAt
        })
      : null
  if (!saved || !promoted || saved.paneKey !== args.paneKey) {
    return null
  }
  return {
    status: {
      paneKey: args.paneKey,
      ...(promoted.tabId ? { tabId: promoted.tabId } : {}),
      worktreeId: promoted.worktreeId,
      connectionId: promoted.connectionId ?? null,
      receivedAt: saved.updatedAt,
      stateStartedAt: saved.updatedAt,
      providerSession: promoted.providerSession,
      state: 'done',
      prompt: promoted.prompt,
      agentType: promoted.agent,
      ...(promoted.lastAssistantMessage
        ? { lastAssistantMessage: promoted.lastAssistantMessage }
        : {})
    },
    // The promotion restamps its clock; the exit must postdate the record as saved.
    ended: endedSince(args, saved.updatedAt)
  }
}

function endedSince(args: { exitedAt?: number; ended?: boolean }, updatedAt: number): boolean {
  return args.ended === true || (args.exitedAt !== undefined && args.exitedAt >= updatedAt)
}
