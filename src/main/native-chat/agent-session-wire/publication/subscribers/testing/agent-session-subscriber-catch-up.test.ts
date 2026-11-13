import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionQueuedMessage } from '../../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { openTestAgentSessionDatabase } from '../../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { createStructuredAgentSessionLogger } from '../../../host/structured-agent-session-logger'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import { structuredAgentSessionStopNoteIdentity } from '../../../operations/structured-agent-session-command-turn'
import { createStructuredAgentSessionStatusReader } from '../../../observations/structured-agent-session-status-reader'
import { indexedStatusFeedSession } from '../../../observations/testing/structured-agent-session-status-feed-test-session.test-fixture'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function openChat(name: string, held: Set<string>) {
  const stateDirectory = join(fixture.root, name)
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory
  })
  const database = await openTestAgentSessionDatabase(stateDirectory)
  const session = {
    ...indexedStatusFeedSession({ journal, provider: 'claude' }),
    child: { phase: 'ready' as const, generation: null, fence: 1, heldSends: () => held }
  }
  const reader = createStructuredAgentSessionStatusReader(
    {
      sessions: new Map([[SESSION, session]]),
      getConversation: () => null,
      now: () => 1_000,
      logger: createStructuredAgentSessionLogger()
    },
    () => {}
  )
  const subscribers = new AgentSessionSubscribers({
    readCurrentWork: reader.work,
    readWorkFrame: reader.workFrame,
    readQueuePublication: async () => ({
      queuedMessages: (await journal.queuedMessages.list()).flatMap(
        (row): AgentSessionQueuedMessage[] =>
          row.state === 'waiting' || row.state === 'returned'
            ? [
                {
                  messageId: row.messageId,
                  position: row.position,
                  body: row.body,
                  state: row.state
                }
              ]
            : []
      ),
      queuePause: null,
      nextQueuedMessageId: null
    })
  })
  const historyReads = vi.spyOn(journal, 'history')
  const panes = new Map<string, StructuredAgentSessionState>()
  const events: AgentSessionSubscribeEvent[] = []
  const eventsOf = new Map<string, AgentSessionSubscribeEvent[]>()
  const open = (id = 'pane', cursor?: AgentJournalCursor) =>
    subscribers.open({
      id,
      sessionId: SESSION,
      journal,
      fence: 1,
      ...(cursor ? { cursor } : {}),
      emit: (event) => {
        events.push(event)
        eventsOf.set(id, [...(eventsOf.get(id) ?? []), event])
        panes.set(
          id,
          reduceStructuredAgentSession(panes.get(id) ?? EMPTY_STRUCTURED_AGENT_SESSION, {
            type: 'event',
            event
          })
        )
      }
    })
  const pane = (id = 'pane') => panes.get(id) ?? EMPTY_STRUCTURED_AGENT_SESSION
  /** A resuming client keeps the state it had at its cursor. */
  const resume = (id: string, from: StructuredAgentSessionState, cursor: AgentJournalCursor) => {
    panes.set(id, from)
    return open(id, cursor)
  }
  const sendState = (id: string, paneId?: string) =>
    pane(paneId).submissions.find((entry) => entry.clientMessageId === id)?.dispatchState
  const delivered = (from: number, id = 'send') =>
    events
      .slice(from)
      .flatMap((event): AgentJournalSubmission[] =>
        event.type === 'batch'
          ? event.batch.submissions
          : event.type === 'snapshot'
            ? event.page.submissions
            : []
      )
      .filter((entry) => entry.clientMessageId === id)
      .map((entry) => entry.dispatchState)
  const submit = (id = 'send') =>
    journal.appendSubmission({
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      body: message('queued send')
    })
  /** The next write commits in SQL, then main adopts it only on `adopt()`. */
  const holdNextAdoption = () => {
    const committed = Promise.withResolvers<void>()
    const adoption = Promise.withResolvers<void>()
    const serialize = database.serialize.bind(database)
    type Writer = Parameters<Parameters<typeof serialize>[1]>[0]
    const spy = vi
      .spyOn(database, 'serialize')
      .mockImplementation(<T>(sessionId: string, run: (writer: Writer) => T | Promise<T>) =>
        serialize(sessionId, (writer) =>
          run({
            write: async (...args: Parameters<Writer['write']>) => {
              const commit = await writer.write(...args)
              spy.mockRestore()
              committed.resolve()
              await adoption.promise
              return commit
            },
            effects: (...args: Parameters<Writer['effects']>) => writer.effects(...args),
            maintain: (...args: Parameters<Writer['maintain']>) => writer.maintain(...args)
          })
        )
      )
    return { committed: committed.promise, adopt: () => adoption.resolve() }
  }
  return {
    journal,
    subscribers,
    events,
    eventsOf,
    historyReads,
    open,
    resume,
    pane,
    sendState,
    delivered,
    submit,
    holdNextAdoption
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 50))

it('a send accepted while its delivery is in flight ends accepted', async () => {
  const chat = await openChat('race', new Set(['send']))
  chat.open()
  await vi.waitFor(() => expect(chat.events.some((event) => event.type === 'snapshot')).toBe(true))
  await chat.submit()
  const before = chat.events.length
  let accepted: Promise<unknown> | undefined
  chat.historyReads.mockImplementationOnce(async (...args) => {
    accepted = chat.journal.resolveDispatch({
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'send-echo' }
    })
    return chat.journal.history(...args)
  })
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() => expect(accepted).toBeDefined())
  await accepted
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() => expect(chat.sendState('send')).toBe('accepted'))

  const states = chat.delivered(before)
  expect(states.slice(states.indexOf('accepted'))).not.toContain('pending')
})

it('a commit readable before main adopts it is delivered only after adoption, with its work', async () => {
  const chat = await openChat('page-ahead', new Set())
  await chat.submit()
  chat.open()
  await vi.waitFor(() => expect(chat.sendState('send')).toBe('unknown'))
  const before = chat.events.length
  const reads = chat.historyReads.mock.calls.length

  const held = chat.holdNextAdoption()
  const written = chat.journal.appendItem(
    { provider: 'orca', clientMessageId: 'unrelated' },
    { kind: 'status', text: 'unrelated' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await held.committed
  chat.subscribers.snapshot(SESSION, chat.journal, 1)
  await settled()
  expect(chat.historyReads.mock.calls.length).toBe(reads)
  expect(chat.events.length).toBe(before)

  held.adopt()
  await written
  await vi.waitFor(() =>
    expect(chat.events.slice(before).some((event) => event.type === 'snapshot')).toBe(true)
  )
  expect(chat.delivered(before)).not.toContain('pending')
  expect(chat.sendState('send')).toBe('unknown')
})

it('a subscriber closed while its capture waits for adoption receives nothing more', async () => {
  const chat = await openChat('cancel', new Set())
  const close = chat.open()
  await vi.waitFor(() => expect(chat.events.some((event) => event.type === 'snapshot')).toBe(true))
  const reads = chat.historyReads.mock.calls.length

  const held = chat.holdNextAdoption()
  const written = chat.submit()
  await held.committed
  chat.subscribers.snapshot(SESSION, chat.journal, 1)
  close()
  const ended = chat.events.length
  held.adopt()
  await written
  await settled()

  expect(chat.events.at(-1)?.type).toBe('end')
  expect(chat.events.length).toBe(ended)
  expect(chat.historyReads.mock.calls.length).toBe(reads)
})

it('a consumed queued card leaves with the page that shows its bubble', async () => {
  const chat = await openChat('queue', new Set())
  await chat.journal.queuedMessages.insert({ messageId: 'card', body: message('card') })
  chat.open()
  const queued = () => (chat.pane().queuedMessages ?? []).some((card) => card.messageId === 'card')
  const bubble = () =>
    chat.pane().items.some((item) => item.itemId === agentJournalSubmissionKey('card-send'))
  await vi.waitFor(() => expect(queued()).toBe(true))
  const seen: boolean[] = []
  const observe = setInterval(() => seen.push(queued() || bubble()), 1)

  const card = await chat.journal.queuedMessages.get('card')
  const held = chat.holdNextAdoption()
  const written = chat.journal.appendSubmission(
    {
      clientMessageId: 'card-send',
      payloadFingerprint: card?.fingerprint ?? '',
      body: message('card'),
      fence: 1,
      handoverRecorded: true
    },
    { messageId: 'card', expect: 'waiting' }
  )
  await held.committed
  // The commit's own publish is never sent; only an earlier one is in flight.
  chat.subscribers.publish(SESSION, chat.journal)
  held.adopt()
  await written
  await vi.waitFor(() => expect(bubble()).toBe(true))
  clearInterval(observe)

  expect(queued()).toBe(false)
  expect(seen).not.toContain(false)
})

it('a resume with stop notes keeps the working state of the frame it caught up to', async () => {
  const chat = await openChat('stop-notes', new Set())
  const turn = { provider: 'orca', clientMessageId: 'turn-1' } as const
  const lifecycle = (state: 'running' | 'interrupted'): AgentJournalItemBody => ({
    kind: 'turn',
    turnId: 'turn-1',
    state
  })
  await chat.journal.appendItem(turn, lifecycle('running'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const note = structuredAgentSessionStopNoteIdentity('turn-1')
  await chat.journal.appendItem(
    note,
    {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' }),
      tone: 'error',
      presentation: 'error'
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) } }
  )
  chat.open()
  await vi.waitFor(() => expect(chat.pane().working).toBe(true))
  const resumeAt = chat.journal.cursor()

  // The turn's completion is committed but not yet adopted when the resume starts.
  const held = chat.holdNextAdoption()
  const written = chat.journal.appendItem(turn, lifecycle('interrupted'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await held.committed
  chat.resume('resumed', chat.pane(), resumeAt)
  await settled()
  held.adopt()
  await written
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() => expect(chat.pane('resumed').working).toBe(false))
  await settled()

  // Rows clear unstated work fields, so every row-carrying frame must state its own.
  const resumed = (chat.eventsOf.get('resumed') ?? []).flatMap((event) =>
    event.type === 'batch' && event.batch.items.length > 0 ? [event.working] : []
  )
  expect(resumed.length).toBeGreaterThan(0)
  expect(resumed.every((working) => working === false)).toBe(true)
  expect(chat.pane('resumed').working).toBe(false)
})

it('a capture whose live authority changes mid-read is replaced, not delivered', async () => {
  const held = new Set(['send'])
  const chat = await openChat('authority', held)
  await chat.submit()
  chat.open()
  await vi.waitFor(() => expect(chat.sendState('send')).toBe('pending'))
  const before = chat.events.length

  chat.historyReads.mockImplementationOnce(async (...args) => {
    const read = chat.journal.history(...args)
    // The child stops holding the send without a row; its owner republishes, as the host does.
    held.clear()
    chat.subscribers.publish(SESSION, chat.journal)
    return read
  })
  chat.subscribers.snapshot(SESSION, chat.journal, 1)
  await vi.waitFor(() => expect(chat.sendState('send')).toBe('unknown'))
  await settled()

  expect(chat.delivered(before)).not.toContain('pending')
  expect(chat.sendState('send')).toBe('unknown')
})
