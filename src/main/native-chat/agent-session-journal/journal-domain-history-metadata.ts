import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  namedSubagents,
  subagentFoldKey,
  subagentItemBlock
} from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  isSubagentRow
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import {
  agentJournalItemForWire,
  shortenedAgentJournalItem
} from '../agent-session-wire/publication/history/agent-session-item-wire-form'

/** Facts history selects before decoding a body; written from each current item revision. */
export type JournalDomainHistoryMetadata = {
  root: number
  subagentRow: number
  subagentGroupKey: string | null
  namedSubagentIds: string[]
  turnMarker: number
  /** Client-form bytes when they differ from the stored payload; null reads the stored length. */
  wireBytes: number | null
  wireJson: string | null
  detailJson: string | null
}

/** Pass the stored payload text when the caller already serialized it. */
export function journalDomainHistoryMetadata(
  item: AgentJournalRenderItem,
  payloadJson?: string,
  displayed = item
): JournalDomainHistoryMetadata {
  const root = isRootAgentJournalItem(item)
  const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
  return {
    root: Number(root),
    subagentRow: Number(isSubagentRow(item)),
    subagentGroupKey: block ? subagentFoldKey(block) : null,
    namedSubagentIds: journalDomainNamedSubagentIds(item),
    turnMarker: Number(
      readAgentJournalTurn(item.body) !== null || isAgentSessionContextClear(item.body)
    ),
    ...journalDomainItemWire(item, payloadJson, displayed)
  }
}

export function journalDomainNamedSubagentIds(item: AgentJournalRenderItem): string[] {
  return isRootAgentJournalItem(item) && item.body.kind === 'message'
    ? item.body.blocks.flatMap(namedSubagents).map((entry) => entry.id)
    : []
}

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
      wireBytes: projected ? bytes : null,
      wireJson: projected ? displayJson : null,
      detailJson
    }
  }
  const sent = agentJournalItemForWire(displayed)
  return {
    wireBytes: !projected && sent.item === item ? null : sent.bytes,
    wireJson: !projected && sent.item === item ? null : JSON.stringify(sent.item),
    detailJson
  }
}
