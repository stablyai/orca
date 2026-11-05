import { runningStructuredAgentSessionTurnItemBySequenceSteps } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { finishJournalSteps, sortJournalSteps } from './journal-reconstruction-steps'
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
  currentSnapshotSteps: (inputIds?: readonly string[]) => Generator<void, AgentJournalSnapshot>
  normalizationKey: string
  prepareSteps: () => Generator<void>
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
  function* snapshotForItemsSteps(
    ids: ReadonlySet<string>,
    preparedItems?: AgentJournalSnapshot['items']
  ): Generator<void, AgentJournalSnapshot> {
    const submissions = new Map<string, AgentJournalSnapshot['submissions'][number]>()
    for (const id of ids) {
      const input = inputForItem(id)
      if (input) {
        submissions.set(input.clientMessageId, input)
      }
      yield
    }
    const rendered =
      preparedItems ?? items ?? snapshot?.items ?? (yield* renderJournalItemSteps(state))
    const ordered = yield* sortJournalSteps(
      submissions.values(),
      (a, b) =>
        a.submittedAt - b.submittedAt ||
        owner.inputOrdinal(a.clientMessageId) - owner.inputOrdinal(b.clientMessageId)
    )
    items = rendered
    return {
      sessionId: state.sessionId,
      cursor: journalContextCursor(state),
      items: rendered,
      submissions: ordered
    }
  }
  function* prepareSteps(): Generator<void> {
    if (snapshot && current && normalization !== undefined) {
      return
    }
    const rendered = items ?? snapshot?.items ?? (yield* renderJournalItemSteps(state))
    const ids = new Set<string>()
    for (const item of rendered) {
      ids.add(item.itemId)
      yield
    }
    const selected = yield* snapshotForItemsSteps(ids, rendered)
    const key = yield* journalNormalizationKeySteps(state, inputForItem)
    const submissions = yield* sortJournalSteps(
      state.submissions.values(),
      (a, b) => a.submittedAt - b.submittedAt
    )
    items = rendered
    current = selected
    normalization = key
    snapshot = { ...selected, submissions }
  }
  function* currentSnapshotSteps(
    inputIds: readonly string[] = []
  ): Generator<void, AgentJournalSnapshot> {
    yield* prepareSteps()
    const base = current!
    if (inputIds.length === 0) {
      return base
    }
    const selected = new Map<string, AgentJournalSnapshot['submissions'][number]>()
    for (const input of base.submissions) {
      selected.set(input.clientMessageId, input)
      yield
    }
    for (const id of inputIds) {
      const input = inputForItem(agentJournalSubmissionKey(id))
      if (input) {
        selected.set(input.clientMessageId, input)
      }
      yield
    }
    return selected.size === base.submissions.length
      ? base
      : {
          ...base,
          submissions: yield* sortJournalSteps(
            selected.values(),
            (a, b) =>
              a.submittedAt - b.submittedAt ||
              owner.inputOrdinal(a.clientMessageId) - owner.inputOrdinal(b.clientMessageId)
          )
        }
  }
  return {
    prepareSteps,
    currentSnapshotSteps,
    get snapshot() {
      return (snapshot ??= renderJournalState(state))
    },
    currentSnapshot(inputIds = []) {
      current ??= this.snapshotForItems(
        new Set((items ??= snapshot?.items ?? renderJournalItems(state)).map((item) => item.itemId))
      )
      if (inputIds.length === 0) {
        return current
      }
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
      return finishJournalSteps(snapshotForItemsSteps(ids))
    }
  }
}

function journalNormalizationKey(
  state: JournalReducerState,
  inputForItem: (id: string) => AgentJournalSnapshot['submissions'][number] | undefined
): string {
  return finishJournalSteps(journalNormalizationKeySteps(state, inputForItem))
}

function* journalNormalizationKeySteps(
  state: JournalReducerState,
  inputForItem: (id: string) => AgentJournalSnapshot['submissions'][number] | undefined
): Generator<void, string> {
  const ids: string[] = []
  for (const itemId of state.items.keys()) {
    const id = inputForItem(itemId)?.clientMessageId
    if (
      id !== undefined &&
      itemId === agentJournalSubmissionKey(id) &&
      state.normalizedHandOffs.has(id)
    ) {
      ids.push(id)
    }
    yield
  }
  const ordered = yield* sortJournalSteps(ids, (a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const corrections: string[] = []
  for (const id of ordered) {
    const item = state.items.get(agentJournalSubmissionKey(id))
    const submission = inputForItem(agentJournalSubmissionKey(id))
    if (item && submission) {
      corrections.push(
        JSON.stringify([
          id,
          item.sequence,
          item.observedAt,
          item.turnScope,
          submission.queuedMessageId ?? null
        ])
      )
    }
    yield
  }
  return corrections.length === 0
    ? ''
    : `[${JSON.stringify(state.epoch)},[${corrections.join(',')}]]`
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
