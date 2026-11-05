import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { namesCliConversation } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { CliWriterObservation } from '../../../agent-hooks/server/cli-writer-observation'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'

/** The process table's own reader takes about this many reads at once. */
const WRITER_PROBE_CONCURRENCY = 8

export type CliWriterHost = {
  rows: () => AgentStatusIpcPayload[]
  observation: (row: AgentStatusIpcPayload) => CliWriterObservation | null
  /** Resolves the host PTY a pane key names now, so a row under an older key still matches its
   *  pane. One resolver serves one synchronous read, sharing its look at the terminals. */
  ptyResolver?: () => (paneKey: string) => string | null
}

/** Only a live holder in the execution host's status store blocks continuation. `closingPaneKeys`
 *  are panes the caller closes before create, so their own agent is not another writer. */
export async function assertCliConversationWritersExited(
  host: CliWriterHost,
  agent: StructuredAgentId,
  providerSessionId: string,
  closingPaneKeys: readonly string[] = []
): Promise<void> {
  const closing = new Set(closingPaneKeys)
  // Only a closing pane needs resolving: with none, no row can be left out.
  const ptyOf = closing.size > 0 ? host.ptyResolver?.() : undefined
  const closingPtyIds = new Set<string>()
  for (const paneKey of closing) {
    const ptyId = ptyOf?.(paneKey)
    if (ptyId) {
      closingPtyIds.add(ptyId)
    }
  }
  const closes = (row: AgentStatusIpcPayload) =>
    closing.has(row.paneKey) ||
    (closingPtyIds.size > 0 && closingPtyIds.has(ptyOf?.(row.paneKey) ?? ''))
  // Chosen in one synchronous pass, so pane identity is read at one instant, before any probe waits.
  const candidates = host.rows().flatMap((row) => {
    if (row.structuredHost || !namesCliConversation(row, agent, providerSessionId)) {
      return []
    }
    const observation = host.observation(row)
    // No recorded process admits. A tmux or shared server outlives the pane it started in, so
    // closing that pane frees nothing.
    if (!observation || (observation.topology === 'pane-owned' && closes(row))) {
      return []
    }
    return [observation]
  })
  let held = false
  // A few probes at a time: the caller's bounded wait (3 s on this machine) must not run out on one
  // slow probe after another, nor may a check start every probe at once. None starts once one
  // holder refuses.
  await forEachWithConcurrency(candidates, WRITER_PROBE_CONCURRENCY, async (observation) => {
    // Only a process proven running refuses; exited and unverifiable admit.
    if (!held && (await observation.presence()) === 'live' && observation.current()) {
      held = true
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  })
}
