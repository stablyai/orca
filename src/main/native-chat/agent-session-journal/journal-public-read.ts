import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalInputOrder } from './journal-input-order'
import { renderJournalItems, renderJournalState, type JournalReducerState } from './journal-reducer'
import { journalContextCursor } from './journal-context-cursor'

/** Only a committed journal owner can certify reuse across public reads. */
export function createJournalPublicReader(inputOrder: () => JournalInputOrder) {
  let current:
    | {
        raw: JournalReducerState
        epoch: string
        sequence: number
        revision: string
        normalizationKey?: string
        view?: ReturnType<typeof readJournalPublicView>
      }
    | undefined
  return (raw: JournalReducerState, display: JournalReducerState, revision: string) => {
    const { epoch, lastSequence: sequence } = raw
    if (
      current?.raw !== raw ||
      current.epoch !== epoch ||
      current.sequence !== sequence ||
      current.revision !== revision
    ) {
      current = { raw, epoch, sequence, revision }
    }
    const source = current
    const owner = inputOrder()
    return (source.view ??= readJournalPublicView(
      display,
      owner,
      () => (source.normalizationKey ??= journalNormalizationKey(display, owner))
    ))
  }
}

/** Row progress cannot certify a historical display that the queue fold corrected. */
export function readJournalPublicView(
  state: JournalReducerState,
  owner: JournalInputOrder,
  normalizationKey = () => journalNormalizationKey(state, owner)
): {
  snapshot: AgentJournalSnapshot
  snapshotForItems: (ids: ReadonlySet<string>) => AgentJournalSnapshot
  normalizationKey: string
} {
  let snapshot: AgentJournalSnapshot | undefined
  let items: AgentJournalSnapshot['items'] | undefined
  return {
    get snapshot() {
      return (snapshot ??= renderJournalState(state))
    },
    get normalizationKey() {
      return normalizationKey()
    },
    snapshotForItems(ids) {
      return {
        sessionId: state.sessionId,
        cursor: journalContextCursor(state),
        items: (items ??= snapshot?.items ?? renderJournalItems(state)),
        submissions: [...ids]
          .flatMap((id) => {
            const input = owner.inputForItem(id)
            const displayed = input && state.submissions.get(input.clientMessageId)
            return displayed ? [displayed] : []
          })
          .sort(
            (a, b) =>
              a.submittedAt - b.submittedAt ||
              owner.inputOrdinal(a.clientMessageId) - owner.inputOrdinal(b.clientMessageId)
          )
      }
    }
  }
}

function journalNormalizationKey(state: JournalReducerState, owner: JournalInputOrder): string {
  const ids = [...state.items.keys()].flatMap((itemId) => {
    const id = owner.inputForItem(itemId)?.clientMessageId
    return id !== undefined && state.normalizedHandOffs.has(id) ? [id] : []
  })
  const corrections = ids.sort().flatMap((id) => {
    const item = state.items.get(agentJournalSubmissionKey(id))
    const submission = state.submissions.get(id)
    return item && submission
      ? [[id, item.sequence, item.observedAt, item.turnScope, submission.queuedMessageId ?? null]]
      : []
  })
  return corrections.length === 0 ? '' : JSON.stringify([state.epoch, corrections])
}

export function renderJournalStatus(state: JournalReducerState, owner: JournalInputOrder) {
  const failed = state.queuePauseMarks.latestStop?.settle?.failedOn
  const items = renderJournalItems(state)
  return {
    items,
    submissions: owner.statusInputs(
      state,
      items,
      failed && 'openedAfter' in failed ? failed.openedAfter : undefined
    )
  }
}
