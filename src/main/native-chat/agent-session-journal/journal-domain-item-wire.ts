import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import {
  agentJournalItemForWire,
  shortenedAgentJournalItem
} from '../agent-session-wire/publication/history/agent-session-item-wire-form'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'

// The client form cuts tool/diff heads and whole items over the page budget; skipping the
// form elsewhere only overstates a size, which shortens a page but never drops content.
export const JOURNAL_ITEM_DETAIL_MAX_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 64 * 1024

export function journalDomainItemWire(
  item: AgentJournalRenderItem,
  payloadJson?: string,
  displayed = item
) {
  const projected = displayed !== item
  const displayJson = projected ? JSON.stringify(displayed) : (payloadJson ?? JSON.stringify(item))
  const bytes = Buffer.byteLength(displayJson, 'utf8')
  const detailJson =
    bytes > JOURNAL_ITEM_DETAIL_MAX_BYTES
      ? JSON.stringify(shortenedAgentJournalItem(displayed, JOURNAL_ITEM_DETAIL_MAX_BYTES, bytes))
      : projected
        ? displayJson
        : null
  if (
    displayed.body.kind !== 'tool-call' &&
    displayed.body.kind !== 'diff' &&
    bytes <= HISTORY_PAGE_CONTENT_BUDGET_BYTES
  ) {
    return {
      wireVersion: AGENT_SESSION_ITEM_WIRE_VERSION,
      wireBytes: projected ? bytes : null,
      wireJson: projected ? displayJson : null,
      detailJson
    }
  }
  const sent = agentJournalItemForWire(displayed)
  return {
    wireVersion: AGENT_SESSION_ITEM_WIRE_VERSION,
    wireBytes: !projected && sent.item === item ? null : sent.bytes,
    wireJson: !projected && sent.item === item ? null : JSON.stringify(sent.item),
    detailJson
  }
}
