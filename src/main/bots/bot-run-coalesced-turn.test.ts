// Two sends Codex folds into one turn: the run's echo names it first, the owner's arrives after the
// turn ends and takes it over. The run posts nothing at either read.
import { describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  acquiredCodexAdapter,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  echoUserMessage,
  fakeCodexAppServer,
  openAfterTurnStarts,
  startTurn,
  type LateSettlement
} from '../codex/structured/turns/codex-structured-dispatch-test-support'
import { deliverBotRunResult, type BotRunDeliveryDependencies } from './bot-run-results'
import { watchBotTurnEnds, type BotTurnEnd } from './bot-run-turn-watch'
import { makeTestBot } from './bot.test-fixture'

const SESSION = 'session-1'
const THREAD: AgentJournalTurnScope = { kind: 'thread' }

/** The rows the translator writes: each item's newest body, at its first write. */
function journalSink() {
  type Row = { body: AgentJournalItemBody; turnScope: AgentJournalTurnScope; sequence: number }
  const rows = new Map<string, Row>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, { turnScope }) => {
      const itemId = agentJournalItemKey(identity)
      rows.set(itemId, { body, turnScope, sequence: rows.get(itemId)?.sequence ?? rows.size + 10 })
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  const items = (): AgentJournalRenderItem[] =>
    [...rows].map(([itemId, row]) => ({ itemId, revision: 0, observedAt: row.sequence, ...row }))
  return { sink, items }
}

/** Both sends as the host records them: handed over with no turn running, accepted once echoed. */
function journalFor(items: AgentJournalRenderItem[], settlements: LateSettlement[]) {
  const sent = (clientMessageId: string, sequence: number): AgentJournalRenderItem => ({
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 0,
    sequence,
    observedAt: sequence,
    turnScope: THREAD,
    body: CODEX_TEST_USER_MESSAGE
  })
  const submission = (clientMessageId: string): AgentJournalSubmission => {
    const echo = settlements.find((settlement) => settlement.clientMessageId === clientMessageId)
    return {
      clientMessageId,
      fence: 7,
      payloadFingerprint: 'sent',
      dispatchState: echo ? 'accepted' : 'pending',
      providerItemId:
        echo && 'providerIdentity' in echo ? agentJournalItemKey(echo.providerIdentity) : null,
      reason: null,
      submittedAt: 1,
      resolvedAt: echo ? 2 : null,
      handoverRecorded: true,
      handedOverAt: 1
    }
  }
  return {
    items: [sent('owner', 1), sent('run', 2), ...items],
    submissions: [submission('owner'), submission('run')]
  }
}

async function readRun(journal: ReturnType<typeof journalFor>): Promise<BotTurnEnd> {
  const host = {
    subscribeTurnCompletions: () => () => {},
    subscribe: async () => () => {},
    currentWork: () => null,
    history: async () => ({ ok: true, page: { queuedMessages: [] } }),
    journalReads: async () => ({
      operationWindow: async () => ({ complete: true, snapshot: journal })
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the host members the watch reads.
  const watch = watchBotTurnEnds(host as unknown as Parameters<typeof watchBotTurnEnds>[0])
  return watch.next({ sessionId: SESSION, clientMessageId: 'run', fingerprint: 'sent' })
}

async function postsFor(ended: BotTurnEnd) {
  const postAsBot = vi.fn<BotRunDeliveryDependencies['postAsBot']>(async () => ({
    ok: true as const,
    value: undefined
  }))
  for (const resultsTo of [{ channel: 'C-RUN-TWO' }, { linearIssue: 'RUN-TWO-ISSUE' }]) {
    await deliverBotRunResult(
      {
        sendToChat: async () => undefined,
        noteToChat: async () => undefined,
        postAsBot,
        replyInThread: () => null,
        turnForOf: async () => 'owner',
        notify: () => {},
        cloudSignedOut: () => false,
        noteToRun: async () => undefined
      },
      {
        automation: { id: 'auto-1', name: 'Alert triage', dtstart: 1 },
        run: { id: 'run-1', trigger: 'scheduled' },
        bot: makeTestBot(),
        target: { runsIn: 'chat', resultsTo },
        sessionId: SESSION,
        ended
      }
    )
  }
  return postAsBot.mock.calls
}

describe('a run whose message Codex answers together with an earlier one', () => {
  it('posts nothing, before or after the earlier echo takes the turn over', async () => {
    const codex = fakeCodexAppServer({
      'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } })
    })
    const settlements: LateSettlement[] = []
    const journal = journalSink()
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink: journal.sink })
    const connection = codex.connections[0]!
    const send = (clientMessageId: string) =>
      adapter.dispatch({
        sessionId: SESSION,
        clientMessageId,
        body: CODEX_TEST_USER_MESSAGE,
        fence: 7,
        requestedAt: 1_700_000_000_100
      })
    const turn = () => journal.items().find((item) => item.body.kind === 'turn')?.body

    const sends = [send('owner'), send('run')]
    await openAfterTurnStarts(connection, 2, () => startTurn(connection, 'turn-1'))
    await Promise.all(sends)
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-run', clientId: 'run' })
    connection.handlers.onNotification?.('item/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1' },
      item: { type: 'agentMessage', id: 'answer', text: 'OWNER / RUN ONE PRIVATE RESULT' }
    })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1', status: 'completed' }
    })
    // The turn/start reply already names the earlier owner message as the opener, before its echo.
    expect(turn()).toMatchObject({
      state: 'completed',
      userItemId: agentJournalSubmissionKey('owner')
    })
    const beforeEcho = await readRun(journalFor(journal.items(), settlements))
    expect(beforeEcho).toEqual({ unavailable: 'shared' })
    expect(await postsFor(beforeEcho)).toEqual([])

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-owner', clientId: 'owner' })
    expect(turn()).toMatchObject({ userItemId: agentJournalSubmissionKey('owner') })
    const afterEcho = await readRun(journalFor(journal.items(), settlements))
    expect(afterEcho).toEqual({ unavailable: 'shared' })
    expect(await postsFor(afterEcho)).toEqual([])
  })
})
