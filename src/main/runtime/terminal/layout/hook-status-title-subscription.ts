import { toAgentStatusIpcPayload } from '../../../agent-hooks/server/server-status-identity'
import type { EnrichedAgentHookEventPayload } from '../../../agent-hooks/server/server-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

/** Main titles agent tabs from each status its hook server accepts, with or without a window. */
export function subscribeHookStatusTitles(
  server: {
    subscribeEnrichedStatus(listener: (row: EnrichedAgentHookEventPayload) => void): () => void
  },
  runtime: { recordHookStatusTitle(row: AgentStatusIpcPayload): void }
): () => void {
  // Switch point: a window-owned build's window derives the titles itself.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return () => {}
  }
  return server.subscribeEnrichedStatus((enriched) =>
    runtime.recordHookStatusTitle(toAgentStatusIpcPayload(enriched))
  )
}
