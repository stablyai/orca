import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * A finished saved item whose tool output or patch a history read cut to a bounded head. Its row
 * already holds the finished output, so catch-up treats it as settled: the source can't add to a
 * finished output, and the cut must never be written back over the row.
 */
export function isSettledCutJournalItem(saved: AgentJournalRenderItem | null | undefined): boolean {
  if (!saved?.shortened) {
    return false
  }
  const { body } = saved
  if (body.kind === 'diff') {
    return body.patch.truncated
  }
  return body.kind === 'tool-call' && body.state !== 'running' && body.output?.truncated === true
}
