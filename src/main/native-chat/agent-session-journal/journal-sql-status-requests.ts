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
} from '../../../shared/agent-session/requests/structured-agent-session-command-entry'
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField
} from '../../../shared/agent-status/contracts/agent-status-field-normalization'
import { isQuietBotResult } from '../../../shared/bot-quiet-result'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalTurnsBehind } from './journal-status-state'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

export type JournalRequestStatus = {
  hasRequest: boolean
  latestPrompt: string
  latestRequest: StructuredAgentSessionLatestRequest | null
  lastAssistantMessage?: string
  /** The newest answer is a bot's quiet marker. */
  quietAnswer?: true
  turnsBehind?: JournalTurnsBehind
}

/** Bounds the scan; a full window still reports that more turns may be merged. */
const TURNS_BEHIND_WINDOW = 8

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
export function readJournalSqlRequestStatus(
  state: JournalSqlStatusContext,
  currentFence?: number | null,
  /** A bot's session, whose quiet-marker answers the preview skips. */
  botSession = false
): JournalRequestStatus {
  const order = state
  const selects = state.select
  const hasRequest =
    state.hasRequestItem() ||
    hasStructuredAgentSessionRequest([], order.statusInputs(), currentFence)
  if (!hasRequest) {
    return { hasRequest: false, latestPrompt: '', latestRequest: null }
  }
  const prompt = selects({ kind: 'prompt' })[Symbol.iterator]().next().value?.item
  const floor = selects({ kind: 'clear' })[Symbol.iterator]().next().value?.item.sequence ?? 0
  const bodyOf = (id: string) => {
    const item = state.displayed(id)
    return item && (!floor || item.sequence > floor) ? item.body : null
  }
  const commands = commandTurnsByBody(bodyOf)
  let latestRequest: StructuredAgentSessionLatestRequest | null = null
  for (const { item } of newestCandidates(
    selects({ kind: 'turns', root: true, floor }),
    selects({ kind: 'users', unknown: true, floor }),
    state.failedItems(floor)
  )) {
    const submission = order.inputForItem(item.itemId)
    const current =
      submission && (!floor || (submission.acceptedSequence ?? 0) > floor) ? submission : undefined
    const displayed = state.displayed(item.itemId)
    if (!displayed) {
      continue
    }
    const candidate = structuredAgentSessionRequestFromItem(
      displayed,
      current,
      (id) => {
        const send = order.steerInput(id)
        return (
          send?.answeredInTurn?.via === 'steer' &&
          send.answeredInTurn.turnItemId === id &&
          (!floor || (send.acceptedSequence ?? 0) > floor)
        )
      },
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
  const quietAnswer = isQuietBotResult(assistant)
  if (quietAnswer && botSession) {
    // After a bot's quiet answer, its preview is its newest answer that said something.
    assistant = ''
    for (const { item } of selects({ kind: 'assistant-prose', floor })) {
      const prose = isStructuredAgentSessionCommandRow(item, commands)
        ? ''
        : latestStructuredAgentSessionAssistantMessage([item], bodyOf)
      if (prose.trim() && !isQuietBotResult(prose)) {
        assistant = prose
        break
      }
    }
  }
  const lastAssistantMessage = normalizeOptionalField(assistant, AGENT_STATUS_MAX_FIELD_LENGTH)
  const turnsBehind =
    quietAnswer && latestRequest?.kind === 'turn'
      ? readTurnsBehind(state, floor, latestRequest.id, commands, bodyOf)
      : undefined
  return {
    hasRequest: true,
    latestPrompt: normalizePromptField(prompt ? latestStructuredAgentSessionPrompt([prompt]) : ''),
    latestRequest,
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    ...(quietAnswer ? { quietAnswer: true as const } : {}),
    ...(turnsBehind ? { turnsBehind } : {})
  }
}

/** Read from rows, not observed states, so a turn that ended unseen still counts. */
function readTurnsBehind(
  state: JournalSqlStatusContext,
  floor: number,
  latestTurnId: string,
  commands: ReturnType<typeof commandTurnsByBody>,
  bodyOf: Parameters<typeof latestStructuredAgentSessionAssistantMessage>[1]
): JournalTurnsBehind {
  const turns: JournalTurnsBehind['turns'][number][] = []
  const seen = new Set([latestTurnId])
  for (const { item, position } of state.select({ kind: 'turns', root: true, floor })) {
    const turn = readAgentJournalTurn(item.body)
    if (!turn || seen.has(turn.turnId)) {
      continue
    }
    seen.add(turn.turnId)
    if (turn.state === 'running') {
      continue
    }
    if (turns.length === TURNS_BEHIND_WINDOW) {
      return { turns, more: true }
    }
    const prose = state
      .select({ kind: 'assistant-prose', floor, turnItemId: item.itemId })
      [Symbol.iterator]()
      .next().value?.item
    const said =
      prose && !isStructuredAgentSessionCommandRow(prose, commands)
        ? latestStructuredAgentSessionAssistantMessage([prose], bodyOf)
        : ''
    turns.push({
      id: turn.turnId,
      sequence: position.sequence,
      answered:
        turn.state === 'completed' &&
        readAgentJournalTurnOutcome(turn) !== null &&
        !isQuietBotResult(said)
    })
  }
  return { turns, more: false }
}

/** Why the settled latest request failed: a refused send's rejection, else the newest failure status
 *  since the last person message; a retry in progress is not why the turn ended. */
export function readJournalSqlTurnFailure(
  state: JournalSqlStatusContext,
  floor: number,
  latestRequest: StructuredAgentSessionLatestRequest | null
): AgentSessionFailureFact | undefined {
  if (latestRequest?.kind === 'refused-send') {
    const submission = state
      .statusInputs()
      .find(
        (entry) =>
          entry.dispatchState === 'rejected' &&
          agentJournalSubmissionKey(entry.clientMessageId) === latestRequest.id
      )
    return readAgentSessionFailureFact(submission?.rejection)
  }
  for (const { item } of newestCandidates(
    state.select({ kind: 'users', floor }),
    state.failedItems(floor)
  )) {
    const body = state.displayed(item.itemId)?.body
    if (body?.kind === 'message' && body.role === 'user') {
      return undefined
    }
    if (body?.kind === 'status' && body.failure && body.failure.kind !== 'providerRetrying') {
      return readAgentSessionFailureFact(body.failure)
    }
  }
  return undefined
}
