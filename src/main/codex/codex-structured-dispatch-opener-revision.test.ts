import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  acquiredCodexAdapter,
  echoUserMessage,
  fakeCodexAppServer,
  openAfterTurnStarts,
  startTurn,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  type LateSettlement
} from './codex-structured-dispatch-test-support'

// The same out-of-order echoes as the dispatch admission test, through a sink that reads what it
// saved, so every turn revision goes through the common resolver: a steer saved as the provisional
// opener is corrected to the earliest send Codex attributes to the turn.

const ACCEPTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/** Saved rows by key, with the submission rows a send saves before it dispatches. */
function readingSink() {
  const saved = new Map<string, AgentJournalItemBody>()
  const order = new Map<string, number>()
  const put = (key: string, body: AgentJournalItemBody) => {
    saved.set(key, body)
    order.set(key, order.size + 1)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the turn-row resolver reads only these members, and `item` only for presence and body.
  const journal = {
    epoch: () => 'epoch-1',
    itemBody: (key: string) => saved.get(key) ?? null,
    item: (key: string) => {
      const body = saved.get(key)
      return body ? { itemId: key, body } : null
    },
    visitItems: (visit: (key: string, sequence: number, body: AgentJournalItemBody) => void) => {
      for (const [key, body] of saved) {
        visit(key, order.get(key) ?? 0, body)
      }
    }
  } as unknown as StructuredAgentSessionRevisionJournal
  const revise: NonNullable<StructuredAgentSessionEventSink['tryReviseResolvedItem']> = (
    _bytes,
    resolve
  ) => {
    const resolved = resolve(journal)
    if (resolved) {
      put(agentJournalItemKey(resolved.identity), resolved.body)
    }
    return ACCEPTED
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => put(agentJournalItemKey(identity), body),
    tryAppendItem: (identity, body) => {
      put(agentJournalItemKey(identity), body)
      return ACCEPTED
    },
    appendTombstone: () => {},
    publish: () => {},
    tryPublish: () => ACCEPTED,
    tryReviseResolvedItem: revise,
    tryReviseResolvedItemAndPublish: revise
  }
  return {
    sink,
    submit: (clientMessageId: string) =>
      put(agentJournalSubmissionKey(clientMessageId), CODEX_TEST_USER_MESSAGE),
    /** The turn record as saved now. */
    turn: () => {
      const body = [...saved.values()].findLast((row) => row.kind === 'turn')
      return body?.kind === 'turn' ? body : undefined
    }
  }
}

/** Two sends both start the turn; Codex answers them only once the test releases the replies. */
async function twoSendsBeforeTheTurnStarts() {
  let release!: () => void
  const replies = new Promise<void>((resolve) => {
    release = resolve
  })
  const codex = fakeCodexAppServer({
    'turn/start': () => replies.then(() => ({ turn: { id: 'turn-1', status: 'inProgress' } })),
    'turn/steer': () => ({ turnId: 'turn-1' })
  })
  const settlements: LateSettlement[] = []
  const journal = readingSink()
  const adapter = await acquiredCodexAdapter({ codex, settlements, sink: journal.sink })
  const connection = codex.connections[0]!
  const send = (clientMessageId: string, requestedAt: number) => {
    journal.submit(clientMessageId)
    return adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId,
      body: CODEX_TEST_USER_MESSAGE,
      fence: 7,
      requestedAt
    })
  }
  const opening = send('client-opening', 1_700_000_000_600)
  const queued = send('client-queued', 1_700_000_000_200)
  await openAfterTurnStarts(connection, 2, () => startTurn(connection, 'turn-1'))
  const echo = (clientId: string) =>
    echoUserMessage(connection, { turnId: 'turn-1', itemId: `item-${clientId}`, clientId })
  const replied = async () => {
    release()
    await Promise.all([opening, queued])
  }
  const end = () =>
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1', status: 'completed' }
    })
  return { journal, echo, replied, end }
}

describe('the opener Codex attributes to a turn, through the common turn-row resolver', () => {
  it('keeps the earliest dispatched origin across out-of-order echoes', async () => {
    const { journal, echo, replied, end } = await twoSendsBeforeTheTurnStarts()
    // The turn started before either reply, and the later send's echo came first: the record
    // names that steer, a saved prompt.
    echo('client-queued')
    expect(journal.turn()?.userItemId).toBe(agentJournalSubmissionKey('client-queued'))
    // The opening send's echo is Codex's own evidence of the earlier send: it corrects the opener,
    // and the replies and the turn's end keep it.
    echo('client-opening')
    expect(journal.turn()?.userItemId).toBe(agentJournalSubmissionKey('client-opening'))
    await replied()
    end()
    expect(journal.turn()).toMatchObject({
      state: 'completed',
      userItemId: agentJournalSubmissionKey('client-opening')
    })
  })

  it('takes the earliest send from its late reply when that send is never echoed', async () => {
    const { journal, echo, replied, end } = await twoSendsBeforeTheTurnStarts()
    echo('client-queued')
    expect(journal.turn()?.userItemId).toBe(agentJournalSubmissionKey('client-queued'))
    await replied()
    end()
    expect(journal.turn()).toMatchObject({
      state: 'completed',
      userItemId: agentJournalSubmissionKey('client-opening')
    })
  })
})
