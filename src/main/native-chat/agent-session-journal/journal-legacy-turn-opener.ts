import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { NativeChatTurnLifecycle } from '../../../shared/native-chat-types'
import type { JournalReplacementItem } from './journal-epoch-replacement'

/**
 * The first user row of the turn a transcript opened last, read while the decoder still sees the
 * boundary that opened it, so a prompt that joined the running turn (a steer) never becomes its
 * opener. Only transcripts whose lines mark turns in order supply it.
 */
export function createLatestTurnOpenerTracker(inLineOrder: boolean) {
  let opened: string | undefined
  let opener: JournalReplacementItem | null = null
  return {
    observe(next: NativeChatTurnLifecycle, current: NativeChatTurnLifecycle | undefined): void {
      const opens = current?.state !== 'working' || current.turnId !== next.turnId
      if (inLineOrder && next.state === 'working' && opens) {
        opened = next.turnId
        opener = null
      }
    },
    seen(item: JournalReplacementItem): JournalReplacementItem {
      if (
        opened !== undefined &&
        !opener &&
        item.body.kind === 'message' &&
        item.body.role === 'user'
      ) {
        opener = item
      }
      return item
    },
    /** `null`: the latest turn opened in view, but its prompt is not among the retained rows. */
    evidence(
      latest: NativeChatTurnLifecycle | undefined,
      retained: readonly JournalReplacementItem[]
    ): { latestTurnOpener?: string | null } {
      if (opened === undefined || latest?.turnId !== opened) {
        return {}
      }
      const kept = opener && retained.includes(opener) ? opener : null
      return { latestTurnOpener: kept && agentJournalItemKey(kept.identity) }
    }
  }
}
