import { getAgentResumeArgv } from '../../../../shared/agent-launch/startup/agent-resume-argv'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { sameAgentIdentity } from '../../../../shared/agent-status/title/agent-title-owner'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'

/** The conversation a slept pane resumes, and where its record's identity comes from. */
export type WorktreeSleepResumeSource = Pick<
  SleepingAgentSessionRecord,
  'agent' | 'providerSession' | 'prompt' | 'updatedAt' | 'connectionId'
>

/** The resume a pane's hook row names; null when the row names no resumable session. */
export function hookRowResumeSource(row: AgentStatusIpcPayload): WorktreeSleepResumeSource | null {
  const agent = row.agentType
  const providerSession = normalizeAgentProviderSession(row.providerSession)
  if (!isResumableTuiAgent(agent) || !providerSession) {
    return null
  }
  return {
    agent,
    providerSession,
    prompt: row.prompt,
    updatedAt: row.receivedAt,
    // Why: the SSH host boundary keeps the id off another machine; a WSL relay tag is local transport.
    connectionId: isLocalHookConnectionId(row.connectionId) ? null : row.connectionId
  }
}

/** The resume a pane's saved live checkpoint names, as the window's own sleep promotes it; null
 *  when it belongs elsewhere, cannot resume, or names another agent than main knows the pane runs. */
export function savedCheckpointResumeSource(
  saved: SleepingAgentSessionRecord | undefined,
  worktreeId: string,
  paneAgent: TerminalAgent | null
): WorktreeSleepResumeSource | null {
  const providerSession = normalizeAgentProviderSession(saved?.providerSession)
  if (
    saved?.origin !== 'live' ||
    saved.worktreeId !== worktreeId ||
    !isResumableTuiAgent(saved.agent) ||
    !providerSession ||
    !getAgentResumeArgv(saved.agent, providerSession) ||
    (paneAgent !== null && !sameAgentIdentity(paneAgent, saved.agent))
  ) {
    return null
  }
  return {
    agent: saved.agent,
    providerSession,
    prompt: saved.prompt,
    updatedAt: saved.updatedAt,
    connectionId: isLocalHookConnectionId(saved.connectionId) ? null : (saved.connectionId ?? null)
  }
}
