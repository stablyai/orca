import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'

export function assistantText(row: AgentJournalRenderItem): string {
  return row.body?.kind === 'message' && row.body.role === 'assistant'
    ? row.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}
