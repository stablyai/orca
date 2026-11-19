import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { promoteSavedLiveResumeRecord } from '../../../shared/agent-session/lifecycle/resume/promote-saved-live-resume-record'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentMainAgentVerdict } from '../../../shared/agent-status/lifecycle/agent-main-agent-verdict'

export type PaneAgentIdentity = {
  status: AgentStatusIpcPayload
  /** The agent left the pane; its identity names what to retire, not what to resume. */
  ended: boolean
  /** Positive local process observation; shell foreground does not end a stopped job. */
  suspended?: true
  /** Shared servers survive the pane; their conversation must not be launched again on wake. */
  executionHost?: 'pane-owned' | 'shared' | 'unverifiable'
}

/** The one rule for which agent conversation a pane holds: its hook row in any at-rest shape,
 *  else its saved resume record, minus an exit recorded since that identity was last updated. */
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
      ? {
          ...placeholder,
          state: 'done',
          ...(agentMainAgentVerdict(row) === null ? { sessionBoundary: true } : {})
        }
      : row
    // Sleep is a resumable physical stop: its exit retires the process, never the conversation.
    if (row.paneSleep) {
      return { status, ended: false }
    }
    // A replayed report restamps receipt but not evidence; only newer evidence outlives an exit.
    return { status, ended: endedSince(args, row.evidenceObservedAt ?? row.receivedAt) }
  }
  const saved = args.savedRecord
  if (!saved || !args.worktreeId || saved.paneKey !== args.paneKey) {
    return null
  }
  const recovered = promoteSavedLiveResumeRecord({
    record: saved,
    worktreeId: args.worktreeId,
    capturedAt: saved.capturedAt,
    includeSleepRecord: true
  })
  if (!recovered) {
    return null
  }
  return {
    status: {
      paneKey: args.paneKey,
      ...(saved.tabId ? { tabId: saved.tabId } : {}),
      worktreeId: saved.worktreeId,
      connectionId: saved.connectionId ?? null,
      receivedAt: saved.updatedAt,
      stateStartedAt: saved.mainAgent?.stateStartedAt ?? saved.updatedAt,
      providerSession: saved.providerSession,
      state: saved.state,
      ...(saved.state === 'done' && agentMainAgentVerdict(saved) === null
        ? { sessionBoundary: true }
        : {}),
      ...(saved.interrupted !== undefined ? { interrupted: saved.interrupted } : {}),
      ...(saved.mainAgent ? { mainAgent: saved.mainAgent } : {}),
      prompt: saved.prompt,
      agentType: saved.agent,
      ...(saved.lastAssistantMessage ? { lastAssistantMessage: saved.lastAssistantMessage } : {})
    },
    // The promotion restamps its clock; the exit must postdate the record as saved.
    ended: endedSince(args, saved.updatedAt)
  }
}

function endedSince(args: { exitedAt?: number; ended?: boolean }, updatedAt: number): boolean {
  return args.ended === true || (args.exitedAt !== undefined && args.exitedAt >= updatedAt)
}
