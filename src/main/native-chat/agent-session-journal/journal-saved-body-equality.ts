import { isDeepStrictEqual } from 'node:util'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * Whether a source's body is the one already saved. A saved item read shortened carries a tool
 * output or patch cut to its head; it still equals the whole text it was cut from, by size and
 * digest, so catch-up doesn't rewrite a large output on every read.
 */
export function sameSavedJournalItemBody(
  saved: AgentJournalRenderItem,
  next: AgentJournalItemBody
): boolean {
  return isDeepStrictEqual(saved.body, saved.shortened ? withSavedHead(saved.body, next) : next)
}

function withSavedHead(
  saved: AgentJournalItemBody,
  next: AgentJournalItemBody
): AgentJournalItemBody {
  const cutFrom = (
    kept: AgentJournalBoundedPayload | undefined,
    whole: AgentJournalBoundedPayload | undefined
  ) =>
    kept !== undefined &&
    whole !== undefined &&
    kept.truncated &&
    !whole.truncated &&
    kept.digest === whole.digest &&
    kept.byteLength === whole.byteLength
  if (
    saved.kind === 'tool-call' &&
    next.kind === 'tool-call' &&
    cutFrom(saved.output, next.output)
  ) {
    return { ...next, output: saved.output }
  }
  if (saved.kind === 'diff' && next.kind === 'diff' && cutFrom(saved.patch, next.patch)) {
    return { ...next, patch: saved.patch }
  }
  return next
}
