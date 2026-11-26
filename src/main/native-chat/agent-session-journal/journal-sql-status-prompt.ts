import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { latestStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { normalizePromptField } from '../../../shared/agent-status/contracts/agent-status-field-normalization'
import type { JournalSqlScope } from './journal-sql-scope'

const MAX_CHAT_PROMPTS = 8192
type PromptPreview = { itemId: string; revision: number; sequence: number; text: string }
const previewsByReader = new WeakMap<Database.Database, Map<string, PromptPreview>>()

/** Assistant publications advance the journal cursor without changing the latest user prompt. */
export function readJournalSqlStatusPrompt(
  scope: JournalSqlScope,
  readItem: (id: string) => AgentJournalRenderItem | undefined
): string {
  const row = scope.db
    .prepare(`SELECT item_id,revision,sequence FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND prompt=1
      ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
    .get(...scope.prefix)
  if (!row) {
    return ''
  }
  scope.examined(row)
  const key = JSON.stringify(scope.prefix)
  const itemId = String(row.item_id)
  const revision = Number(row.revision)
  const sequence = Number(row.sequence)
  let previews = previewsByReader.get(scope.db)
  if (!previews) {
    previews = new Map()
    previewsByReader.set(scope.db, previews)
  }
  const previous = previews.get(key)
  if (
    previous?.itemId === itemId &&
    previous.revision === revision &&
    previous.sequence === sequence
  ) {
    previews.delete(key)
    previews.set(key, previous)
    return previous.text
  }
  const item = readItem(itemId)
  const text = item ? normalizePromptField(latestStructuredAgentSessionPrompt([item])) : ''
  previews.delete(key)
  previews.set(key, { itemId, revision, sequence, text })
  if (previews.size > MAX_CHAT_PROMPTS) {
    const oldest = previews.keys().next()
    if (!oldest.done) {
      previews.delete(oldest.value)
    }
  }
  return text
}
