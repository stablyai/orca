// A bot automation run's turn: started before its prompt is sent, it ends when the run's own turn does.
import { randomUUID } from 'node:crypto'
import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import type {
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionTurnAssistantMessage } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { structuredAgentSessionTurnFailureReport } from '../../shared/agent-session/requests/structured-agent-session-turn-failure'
import type { AgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { structuredAgentSessionSendTurn } from '../../shared/structured-agent-session-send-turn'
import { readAgentJournalTurnOutcome } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { pendingStructuredAgentSessionPrompt } from '../../shared/agent-session/view/structured-agent-session-projection'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createKeyedTrailingEdgeCoalescer } from '../runtime/client/events/keyed-trailing-edge-coalescer'

/** Why a run has no result of its own (result_unavailable). */
export type BotRunUnavailable =
  /** Its queued message left the queue before it went. */
  | 'removed'
  /** Its queued message was edited before it went, so the answer is to another prompt. */
  | 'edited'
  /** Another message went, or may have gone, into the turn that answered it. */
  | 'shared'
  /** No turn can be told as its own. */
  | 'unattributed'
  /** Its turn's end could not be read. */
  | 'unread'

export type BotTurnEnd =
  | {
      outcome: AgentJournalTurnOutcome
      message: string
      error?: string
      /** Why the agent refused the prompt before any turn, such as a failed start. */
      refusal?: AgentJournalSubmission['rejection']
      /** On failure: the typed reason, when the journal recorded one this build reads. */
      failure?: AgentSessionFailureFact
    }
  | { unavailable: BotRunUnavailable }

/** The message a run sent, which names the turn it started, and its body's fingerprint, which a
 *  queued card keeps until it is edited. */
export type BotRunSend = {
  sessionId: string
  clientMessageId: string
  fingerprint: string
  launchModel?: string
}

export type BotTurnWatch = {
  /** The end of the turn this send started; the watch ends with it. */
  next(send: BotRunSend): Promise<BotTurnEnd>
  dispose(): void
}

type BotTurnHost = Pick<
  StructuredAgentSessionHost,
  'subscribeTurnCompletions' | 'subscribe' | 'journalReads' | 'history' | 'currentWork'
>

/** Streaming changes the journal many times a second; the run re-reads it once it settles. */
const JOURNAL_WAKE = { flushMs: 300, maxWaitMs: 2_000 }

const unavailable = (reason: BotRunUnavailable): BotTurnEnd => ({ unavailable: reason })

/** How the turn this send started ended. Null while it hasn't. */
async function readRunTurn(host: BotTurnHost, send: BotRunSend): Promise<BotTurnEnd | null> {
  const { sessionId, clientMessageId } = send
  // Before the journal: a card handed over between the two reads then shows its handoff.
  const history = await host.history({ sessionId, direction: 'tail' })
  const queued =
    history.ok &&
    history.page.queuedMessages?.some(
      (card) => card.messageId === clientMessageId && card.state === 'waiting'
    ) === true
  // The rows that place this send's turn, not the whole chat: the run re-reads at each change.
  const { items, submissions } = (
    await (await host.journalReads(sessionId)).operationWindow({ operationIds: [clientMessageId] })
  ).snapshot
  const placed = structuredAgentSessionSendTurn({ items, submissions }, send)
  let sent: { itemId: string; turn: AgentJournalTurnLifecycle }
  switch (placed.kind) {
    case 'unsent':
      return queued ? null : unavailable('removed')
    case 'edited':
      return unavailable('edited')
    case 'shared':
      // Its prompt is handled in that turn, so the run ends as it does; never with its answer.
      if (!placed.turn) {
        return unavailable('shared')
      }
      sent = placed.turn
      break
    case 'pending':
      return null
    case 'refused':
      return {
        outcome: 'failure',
        message: '',
        ...(placed.rejection ? { refusal: placed.rejection } : {})
      }
    case 'none':
      return unavailable('unattributed')
    case 'turn':
      sent = placed
      break
  }
  const shared = placed.kind === 'shared'
  const outcome = readAgentJournalTurnOutcome(sent.turn)
  // A turn that stops on a question for the user has not finished yet; a failure still ends it. Only
  // the live agent's questions count: one left by an agent that has since stopped gets no answer.
  const work = await host.currentWork(sessionId)
  const asking =
    work !== null &&
    items.some(
      (item) =>
        item.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === sent.itemId &&
        pendingStructuredAgentSessionPrompt(work.scope)(item)
    )
  if (sent.turn.state === 'running' || (outcome === 'success' && asking)) {
    return null
  }
  if (shared && outcome === 'success') {
    return unavailable('shared')
  }
  return outcome
    ? {
        outcome,
        message: shared ? '' : structuredAgentSessionTurnAssistantMessage(items, sent.itemId),
        ...(outcome === 'failure'
          ? structuredAgentSessionTurnFailureReport(items, sent.itemId)
          : {})
      }
    : unavailable('unread')
}

/** Started before the prompt is sent, so a turn that ends before its session id is known still
 *  counts. The run re-reads its turn at each turn end and journal change in its session: in a busy
 *  Chat other turns end first, and a turn end is announced only once no queued send is owed. */
export function watchBotTurnEnds(host: BotTurnHost): BotTurnWatch {
  const turnEnds = new Map<string, number>()
  let ended = false
  let wake = (): void => {}
  const dispose = host.subscribeTurnCompletions({
    id: `bot-run:${randomUUID()}`,
    emit: (event) => {
      if (event.type === 'end') {
        ended = true
      } else if (event.type === 'completion') {
        const { sessionId } = event.completion
        turnEnds.set(sessionId, (turnEnds.get(sessionId) ?? 0) + 1)
      } else {
        return
      }
      wake()
    }
  })
  return {
    dispose,
    next: async (send) => {
      let changes = 0
      const journalChanged = createKeyedTrailingEdgeCoalescer(() => {
        changes += 1
        wake()
      }, JOURNAL_WAKE)
      // Without it the run still wakes at turn ends.
      const unsubscribe = await host
        .subscribe({
          id: `bot-run:${randomUUID()}`,
          sessionId: send.sessionId,
          emit: (event) => {
            if (event.type === 'batch' || event.type === 'reset') {
              journalChanged.schedule(send.sessionId)
            }
          }
        })
        .catch(() => () => {})
      const seen = () => (turnEnds.get(send.sessionId) ?? 0) + changes
      try {
        for (;;) {
          const before = seen()
          // A journal that can't be read can't tell which turn was the run's.
          const end = await readRunTurn(host, send).catch(() => unavailable('unread'))
          if (end) {
            return end
          }
          while (seen() === before) {
            if (ended) {
              throw new Error('Orca stopped watching this run before it reported completion.')
            }
            await new Promise<void>((resolve) => (wake = resolve))
          }
        }
      } finally {
        journalChanged.dispose()
        unsubscribe()
        dispose()
      }
    }
  }
}
