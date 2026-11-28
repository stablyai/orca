import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  clampUtf8TextPrefix,
  clampUtf8TextTail,
  isUtf8ByteLengthWithinLimit
} from '../../../shared/text/utf8-byte-limits'

/** A finished tool call's saved output keeps at most this many bytes, its start and end. */
export const JOURNAL_TOOL_OUTPUT_CAP_BYTES = 64 * 1024

function capMarker(byteLength: number): string {
  return `\n… output truncated when saved, ${byteLength} bytes in total …\n`
}

/**
 * The saved row keeps an output's first and last bytes; the middle is gone for good, as in a
 * terminal's scrollback. An output a previous revision already saved whole is never cut later.
 */
export function capJournalToolOutput<T extends AgentJournalRenderItem>(
  item: T,
  previous: AgentJournalRenderItem | undefined
): T {
  const { body } = item
  if (
    body.kind !== 'tool-call' ||
    body.state === 'running' ||
    !body.output ||
    isUtf8ByteLengthWithinLimit(body.output.head, JOURNAL_TOOL_OUTPUT_CAP_BYTES)
  ) {
    return item
  }
  const { output } = body
  const saved = previous?.body
  if (
    saved?.kind === 'tool-call' &&
    saved.output?.digest === output.digest &&
    saved.output.head === output.head
  ) {
    return item
  }
  const marker = capMarker(output.byteLength)
  const half = Math.floor((JOURNAL_TOOL_OUTPUT_CAP_BYTES - Buffer.byteLength(marker, 'utf8')) / 2)
  const head = `${clampUtf8TextPrefix(output.head, half)}${marker}${clampUtf8TextTail(output.head, half).text}`
  return { ...item, body: { ...body, output: { ...output, head, truncated: true } } }
}

/** The saved item with the whole output it was written from, for readers of facts in the middle (pushes). */
export function withUncappedToolOutput(
  saved: AgentJournalRenderItem,
  written: AgentJournalRenderItem
): AgentJournalRenderItem {
  return saved.body.kind === 'tool-call' &&
    written.body.kind === 'tool-call' &&
    saved.body.output?.digest === written.body.output?.digest &&
    saved.body.output?.head !== written.body.output?.head
    ? { ...saved, body: { ...saved.body, output: written.body.output } }
    : saved
}
