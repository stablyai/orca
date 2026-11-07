import {
  hasStructuredAgentSessionRequest,
  latestStructuredAgentSessionAssistantMessage,
  latestStructuredAgentSessionPrompt,
  structuredAgentSessionRequestFromItem,
  type StructuredAgentSessionLatestRequest
} from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import {
  commandTurnsByBody,
  isStructuredAgentSessionCommandRow
} from '../../../shared/agent-session/structured-agent-session-command-entry'
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField
} from '../../../shared/agent-status/contracts/agent-status-field-normalization'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatusItem } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

export type JournalRequestStatus = {
  hasRequest: boolean
  latestPrompt: string
  latestRequest: StructuredAgentSessionLatestRequest | null
  lastAssistantMessage?: string
}

function* newestCandidates(
  ...populations: Iterable<JournalStatusItem>[]
): Iterable<JournalStatusItem> {
  const iterators = populations.map((items) => items[Symbol.iterator]())
  const next = iterators.map((iterator) => iterator.next())
  for (;;) {
    let winner = -1
    next.forEach((candidate, index) => {
      if (
        !candidate.done &&
        (winner === -1 ||
          compareJournalStatusPositions(candidate.value.position, next[winner]!.value!.position) >
            0)
      ) {
        winner = index
      }
    })
    if (winner === -1) {
      return
    }
    yield next[winner]!.value!
    next[winner] = iterators[winner]!.next()
  }
}

/** Named populations preserve whole-history existence/prompt and strict current-context verdicts. */
export function readJournalRequestStatus(
  state: JournalReducerState,
  currentFence?: number | null
): JournalRequestStatus {
  const order = journalInputOrder(state)
  const selects = (selection: Parameters<typeof state.queries.statusItems>[1]) =>
    state.queries.statusItems(state, selection)
  const hasRequest =
    state.queries.hasStatusRequestItem(state) ||
    hasStructuredAgentSessionRequest([], order.statusInputs(state, []), currentFence)
  if (!hasRequest) {
    return { hasRequest: false, latestPrompt: '', latestRequest: null }
  }
  const prompt = selects({ kind: 'prompt' })[Symbol.iterator]().next().value?.item
  const floor = selects({ kind: 'clear' })[Symbol.iterator]().next().value?.item.sequence ?? 0
  const bodyOf = (id: string) => {
    const item = renderJournalStatusItem(state, id)
    return item && (!floor || item.sequence > floor) ? item.body : null
  }
  const commands = commandTurnsByBody(bodyOf)
  let latestRequest: StructuredAgentSessionLatestRequest | null = null
  for (const { item } of newestCandidates(
    selects({ kind: 'turns', root: true, floor }),
    selects({ kind: 'users', unknown: true, floor }),
    state.queries.failedStatusItems(state, floor)
  )) {
    const submission = order.inputForItem(item.itemId)
    const current =
      submission && (!floor || (submission.acceptedSequence ?? 0) > floor) ? submission : undefined
    const displayed = renderJournalStatusItem(state, item.itemId)
    if (!displayed) {
      continue
    }
    const candidate = structuredAgentSessionRequestFromItem(
      displayed,
      current,
      (id) =>
        order
          .statusInputs(state, [item])
          .some(
            (send) =>
              send.answeredInTurn?.via === 'steer' &&
              send.answeredInTurn.turnItemId === id &&
              (!floor || (send.acceptedSequence ?? 0) > floor)
          ),
      commands
    )
    if (candidate !== undefined) {
      latestRequest = candidate
      break
    }
  }
  let assistant = ''
  for (const { item } of newestCandidates(
    selects({ kind: 'assistant-prose', floor }),
    selects({ kind: 'users', floor })
  )) {
    if (isStructuredAgentSessionCommandRow(item, commands)) {
      continue
    }
    assistant = latestStructuredAgentSessionAssistantMessage([item], bodyOf)
    break
  }
  const lastAssistantMessage = normalizeOptionalField(assistant, AGENT_STATUS_MAX_FIELD_LENGTH)
  return {
    hasRequest: true,
    latestPrompt: normalizePromptField(prompt ? latestStructuredAgentSessionPrompt([prompt]) : ''),
    latestRequest,
    ...(lastAssistantMessage ? { lastAssistantMessage } : {})
  }
}
