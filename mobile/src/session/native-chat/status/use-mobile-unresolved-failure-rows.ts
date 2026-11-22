import { useMemo } from 'react'
import { agentSessionUnresolvedFailureRows } from '../../../../../src/shared/agent-session/failures/agent-session-visible-failures'
import { rowsBesideStreamedText } from '../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'

/** Setup failure rows no later successful turn resolved, as desktop reads them. */
export function useMobileUnresolvedFailureRows(
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  // Failures read no reply text, so a streamed reply's revisions reuse the last scan.
  const rows = rowsBesideStreamedText(items)
  // Keyed by its ids so a streamed reply or a send leaves the set, and every notice row, alone.
  const key = useMemo(
    () => agentSessionUnresolvedFailureRows(rows, { sentMessages: false }).join('\n'),
    [rows]
  )
  return useMemo(() => new Set(key.split('\n')), [key])
}
