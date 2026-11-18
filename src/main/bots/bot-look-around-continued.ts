// A look its usage limit stopped finishes when its session is continued (by Orca at the reset, or
// by the owner): the turn that succeeds there records the look as done, with what it suggested.
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { BotLookAroundStore } from './bot-look-around-store'
import { continuable, expired, type BotLookState } from './bot-look-around-state'

/** A continued look's turn finished: the look is done as of now, its failure gone, and like any
 *  finished look its suggestions replace the open list. Any other session changes nothing. */
export function settleContinuedRun(
  state: BotLookState,
  sessionId: string,
  now: number
): BotLookState {
  const run = state.runs.find((entry) => entry.sessionId === sessionId)
  if (!run || !continuable(state, run)) {
    return state
  }
  const runs = state.runs.map((entry) =>
    entry === run ? { sessionId, startedAt: run.startedAt, endedAt: now } : entry
  )
  const suggestions = state.suggestions.map((entry) =>
    entry.status === 'open' && entry.runSessionId !== sessionId
      ? { ...entry, status: 'replaced' as const, resolvedAt: now }
      : entry
  )
  return expired({ ...state, runs, suggestions }, now)
}

type ContinuedLookStore = Pick<BotLookAroundStore, 'botOfLook' | 'update'>

/** Settles the look a successful turn continued; any other turn changes nothing. */
export function settleContinuedLook(
  store: ContinuedLookStore,
  event: AgentSessionTurnCompletionEvent,
  now: number
): void {
  if (event.type !== 'completion' || event.completion.outcome !== 'success') {
    return
  }
  const { sessionId } = event.completion
  const botId = store.botOfLook(sessionId)
  if (botId !== null) {
    store.update(botId, (state) => ({
      state: settleContinuedRun(state, sessionId, now),
      result: undefined
    }))
  }
}

type TurnCompletionHost = {
  subscribeTurnCompletions(subscriber: {
    id: string
    emit: (event: AgentSessionTurnCompletionEvent) => void
  }): () => void
}

/** Watches every turn on the host for the life of the runtime. */
export function watchContinuedLooks(
  host: TurnCompletionHost,
  store: ContinuedLookStore,
  now: () => number
): () => void {
  return host.subscribeTurnCompletions({
    id: 'bot-look-around-continued',
    emit: (event) => settleContinuedLook(store, event, now())
  })
}
