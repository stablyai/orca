import { withJournalReasoningLifecycle } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-reasoning-row'
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

/** Only reply and reasoning text is shown between saves: command output can be far larger, and a
 *  plan's status row is no text a reader can append to, so it would be built only to be dropped. */
export function codexShowsLiveText(item: CodexThreadItem | undefined): boolean {
  return item?.type === 'agentMessage' || item?.type === 'reasoning'
}
