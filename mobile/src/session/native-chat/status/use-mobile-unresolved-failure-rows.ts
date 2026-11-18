import { useMemo } from 'react'
import { agentSessionUnresolvedFailureRows } from '../../../../../src/shared/agent-session/failures/agent-session-visible-failures'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'

/** Rows whose failure no later successful turn resolved, as desktop reads them. */
export function useMobileUnresolvedFailureRows(
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  // Keyed by its ids so a streamed reply leaves the set, and the rows reading it, alone.
  const key = useMemo(() => agentSessionUnresolvedFailureRows(items).join('\n'), [items])
  return useMemo(() => new Set(key.split('\n')), [key])
}
