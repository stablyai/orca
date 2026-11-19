import { useMemo } from 'react'
import { agentSessionUnresolvedFailureRows } from '../../../../../src/shared/agent-session/failures/agent-session-visible-failures'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'

/** Setup failure rows no later successful turn resolved, as desktop reads them. */
export function useMobileUnresolvedFailureRows(
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  // Keyed by its ids so a streamed reply or a send leaves the set, and every notice row, alone.
  const key = useMemo(
    () => agentSessionUnresolvedFailureRows(items, { sentMessages: false }).join('\n'),
    [items]
  )
  return useMemo(() => new Set(key.split('\n')), [key])
}
