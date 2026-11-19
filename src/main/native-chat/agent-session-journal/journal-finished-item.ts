import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * A provider-finished item with its output or patch saved is final at every size: a provider's own
 * record of it is a lossy copy (Codex rollouts middle-cut outputs), so catch-up never revises it.
 * A call the host closed (`endedAs`) or one still running stays reconcilable.
 */
export function isFinishedJournalOutputItem(
  saved: AgentJournalRenderItem | null | undefined
): boolean {
  const body = saved?.body
  if (body?.kind === 'diff') {
    return true
  }
  return (
    body?.kind === 'tool-call' &&
    body.state !== 'running' &&
    body.endedAs === undefined &&
    body.output !== undefined
  )
}
