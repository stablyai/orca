import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatus, renderJournalStatusItem } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'

function snapshotSince(state: JournalReducerState, floor: number) {
  const snapshot = renderJournalStatus(state, journalInputOrder(state))
  return {
    items: snapshot.items.filter((item) => !floor || item.sequence > floor),
    submissions: snapshot.submissions.filter(
      (send) => !floor || (send.acceptedSequence ?? 0) > floor
    ),
    bodyOf: (id: string) => {
      const item = renderJournalStatusItem(state, id)
      return item && (!floor || item.sequence > floor) ? item.body : null
    }
  }
}

export function readJournalUsageLimitCut(state: JournalReducerState, floor = 0) {
  const snapshot = snapshotSince(state, floor)
  return latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions, snapshot.bodyOf)
}

export function readJournalUsageLimitContinueIdentity(
  state: JournalReducerState
): UsageLimitContinueIdentity | undefined {
  const cut = readJournalUsageLimitCut(state)
  return cut?.resetsAt !== undefined && Number.isFinite(cut.resetsAt)
    ? { turnItemId: cut.turnItemId, resetsAt: cut.resetsAt }
    : undefined
}

export function readJournalOrcaStopCut(state: JournalReducerState, floor = 0) {
  const snapshot = snapshotSince(state, floor)
  return latestNativeChatOrcaStopCut(snapshot.items, snapshot.submissions, snapshot.bodyOf)
}
