import {
  liveJournalReasoningBody,
  withJournalReasoningLifecycle
} from '../../../native-chat/agent-session-journal/item-lifecycle/journal-reasoning-row'
import { codexStreamingJournalItem } from './codex-structured-item-translation'
import type { CodexThreadItem } from './codex-thread-item-identity'

/** The row body a stream shows and saves while its item is still running. */
export function codexRunningStreamBody(item: CodexThreadItem | undefined, text: string) {
  if (!item) {
    return null
  }
  const translated = codexStreamingJournalItem(item, text)
  return translated.body && withJournalReasoningLifecycle(translated.body, { state: 'running' })
}

/** Command output can be far larger than replies, so only reply text is shown between saves. */
export function codexShowsLiveText(item: CodexThreadItem | undefined): boolean {
  return item?.type === 'agentMessage' || item?.type === 'reasoning'
}

/** Live reasoning has already been placed by a nonblank durable save. */
export function codexLiveStreamBody(item: CodexThreadItem | undefined, text: string) {
  return item?.type === 'reasoning'
    ? liveJournalReasoningBody(text)
    : codexRunningStreamBody(item, text)
}
