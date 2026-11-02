import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { StructuredAgentId } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { namesCliConversation } from '../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'

export type CliWriterHost = {
  rows: () => AgentStatusIpcPayload[]
  observation: (row: AgentStatusIpcPayload) => CliWriterObservation | null
  /** The host PTY a pane key names now, so a row under an older key still matches its pane. */
  ptyIdForPaneKey?: (paneKey: string) => string | null
}

/** Only a live holder in the execution host's status store blocks continuation. `closingPaneKeys`
 *  are panes the caller closes before create, so their own agent is not another writer. */
export async function assertCliConversationWritersExited(
  host: CliWriterHost,
  agent: StructuredAgentId,
  providerSessionId: string,
  closingPaneKeys: readonly string[] = []
): Promise<void> {
  const ptyOf = (paneKey: string) => host.ptyIdForPaneKey?.(paneKey) ?? null
  const closingPtyIds = new Set(closingPaneKeys.map(ptyOf).filter((ptyId) => ptyId !== null))
  const closes = (row: AgentStatusIpcPayload) =>
    closingPaneKeys.includes(row.paneKey) || closingPtyIds.has(ptyOf(row.paneKey) ?? '')
  // Probed together: a caller's bounded wait must not run out on one slow probe after another.
  await Promise.all(
    host.rows().map(async (row) => {
      if (row.structuredHost || !namesCliConversation(row, agent, providerSessionId)) {
        return
      }
      const observation = host.observation(row)
      // A tmux or shared server outlives the pane it started in, so closing that pane frees nothing.
      if (observation?.topology === 'pane-owned' && closes(row)) {
        return
      }
      // Only a process proven running refuses; no recorded process, exited and unverifiable admit.
      if ((await observation?.presence()) === 'live' && observation?.current()) {
        throw agentSessionRefusalError('agent_session_conflict', {
          reason: 'conversationHeldElsewhere'
        })
      }
    })
  )
}
