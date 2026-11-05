import { runningStructuredAgentSessionTurnItemBySequenceSteps } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { finishJournalSteps } from './journal-reconstruction-steps'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalInputOrder } from './journal-input-order'
import {
  renderJournalItemSteps,
  renderJournalItems,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import { journalContextCursor } from './journal-context-cursor'

/** Only a committed journal owner can certify reuse across public reads. */
export function createJournalPublicReader(inputOrder: () => JournalInputOrder) {
  let current:
    | {
        raw: JournalReducerState
        epoch: string
        sequence: number
        revision: string
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
    return (source.view ??= readJournalPublicView(display, owner))
  }
}

/** Row progress cannot certify a historical display that the queue fold corrected. */
export function readJournalPublicView(
  state: JournalReducerState,
  owner: JournalInputOrder
): {
  snapshot: AgentJournalSnapshot
  snapshotForItems: (ids: ReadonlySet<string>) => AgentJournalSnapshot
  currentSnapshot: (inputIds?: readonly string[]) => AgentJournalSnapshot
  normalizationKey: string
} {
  let snapshot: AgentJournalSnapshot | undefined
  let items: AgentJournalSnapshot['items'] | undefined
  let current: AgentJournalSnapshot | undefined
  let normalization: string | undefined
  const inputs = new Map<string, AgentJournalSnapshot['submissions'][number] | undefined>()
  const inputForItem = (id: string) => {
    if (!inputs.has(id)) {
      const input = owner.inputForItem(id) ?? owner.firstInputForProviderItem(id)
      inputs.set(id, input && state.submissions.get(input.clientMessageId))
    }
    return inputs.get(id)
  }
  return {
    get snapshot() {
      return (snapshot ??= renderJournalState(state))
    },
    currentSnapshot(inputIds = []) {
      current ??= this.snapshotForItems(
        new Set((items ??= snapshot?.items ?? renderJournalItems(state)).map((item) => item.itemId))
      )
      const selected = new Map(current.submissions.map((input) => [input.clientMessageId, input]))
      for (const id of inputIds) {
        const input = inputForItem(agentJournalSubmissionKey(id))
        if (input) {
          selected.set(input.clientMessageId, input)
        }
      }
      return selected.size === current.submissions.length
        ? current
        : {
            ...current,
            submissions: [...selected.values()].sort(
              (a, b) =>
                a.submittedAt - b.submittedAt ||
                owner.inputOrdinal(a.clientMessageId) - owner.inputOrdinal(b.clientMessageId)
            )
          }
    },
    get normalizationKey() {
      return (normalization ??= journalNormalizationKey(state, inputForItem))
    },
    snapshotForItems(ids) {
      const submissions = new Map<string, AgentJournalSnapshot['submissions'][number]>()
      for (const id of ids) {
        const input = inputForItem(id)
        if (input) {
          submissions.set(input.clientMessageId, input)
        }
      }
      return {
        sessionId: state.sessionId,
        cursor: journalContextCursor(state),
        items: (items ??= snapshot?.items ?? renderJournalItems(state)),
        submissions: [...submissions.values()].sort(
          (a, b) =>
            a.submittedAt - b.submittedAt ||
            owner.inputOrdinal(a.clientMessageId) - owner.inputOrdinal(b.clientMessageId)
        )
      }
    }
  }
}

function journalNormalizationKey(
  state: JournalReducerState,
  inputForItem: (id: string) => AgentJournalSnapshot['submissions'][number] | undefined
): string {
  const ids = [...state.items.keys()].flatMap((itemId) => {
    const id = inputForItem(itemId)?.clientMessageId
    return id !== undefined &&
      itemId === agentJournalSubmissionKey(id) &&
      state.normalizedHandOffs.has(id)
      ? [id]
      : []
  })
  const corrections = ids.sort().flatMap((id) => {
    const item = state.items.get(agentJournalSubmissionKey(id))
    const submission = inputForItem(agentJournalSubmissionKey(id))
    return item && submission
      ? [[id, item.sequence, item.observedAt, item.turnScope, submission.queuedMessageId ?? null]]
      : []
  })
  return corrections.length === 0 ? '' : JSON.stringify([state.epoch, corrections])
}

export function renderJournalStatus(state: JournalReducerState, owner: JournalInputOrder) {
  return finishJournalSteps(renderJournalStatusSteps(state, owner))
}

export function* renderJournalStatusSteps(
  state: JournalReducerState,
  owner: JournalInputOrder
): Generator<
  void,
  { items: AgentJournalSnapshot['items']; submissions: AgentJournalSnapshot['submissions'] }
> {
  const failed = state.queuePauseMarks.latestStop?.settle?.failedOn
  const items = yield* renderJournalItemSteps(state)
  const submissions = yield* owner.statusInputSteps(
    state,
    items,
    failed && 'openedAfter' in failed ? failed.openedAfter : undefined
  )
  return { items, submissions }
}

type RunningTurn = { item: AgentJournalSnapshot['items'][number]; turnId: string } | null
const runningTurns = new WeakMap<JournalReducerState, { sequence: number; turn: RunningTurn }>()
export function readJournalRunningTurn(state: JournalReducerState): RunningTurn {
  return finishJournalSteps(prepareJournalRunningTurnSteps(state))
}
export function* prepareJournalRunningTurnSteps(
  state: JournalReducerState
): Generator<void, RunningTurn> {
  let cached = runningTurns.get(state)
  if (cached?.sequence !== state.lastSequence) {
    const turn = yield* runningStructuredAgentSessionTurnItemBySequenceSteps(state.items.values())
    cached = { sequence: state.lastSequence, turn }
    runningTurns.set(state, cached)
  }
  return cached.turn
}
