import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { digestPayload } from './item-lifecycle/journal-payload-bounds'

/** A saved item read shortened: its tool output or patch, cut to a head but still naming its whole text. */
export function cutJournalOutput(
  saved: AgentJournalRenderItem | null | undefined
): AgentJournalBoundedPayload | undefined {
  if (!saved?.shortened) {
    return undefined
  }
  const payload = savedJournalPayload(saved.body)
  return payload?.truncated ? payload : undefined
}

/** Whether `text` is the whole text a cut payload was taken from. */
export function isCutJournalOutputOf(cut: AgentJournalBoundedPayload, text: unknown): boolean {
  return (
    typeof text === 'string' &&
    text.length * 3 >= cut.byteLength &&
    Buffer.byteLength(text, 'utf8') === cut.byteLength &&
    digestPayload(text) === cut.digest
  )
}

export function savedJournalPayload(
  body: AgentJournalItemBody
): AgentJournalBoundedPayload | undefined {
  return body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : undefined
}
