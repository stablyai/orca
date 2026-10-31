import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentJournalTurnOutcome } from '../../shared/agent-turn-outcome'
import { orcaShutdownRowClientMessageId } from '../../shared/native-chat/native-chat-orca-stop-cut'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { AgentHookServer } from '../agent-hooks/server'
import { AgentStatusObservedPaneIdentities } from './agent-status-observed-pane-identity'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { StatusFeedSession } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-deps'
import { AgentSessionSubscribers } from '../native-chat/agent-session-wire/structured-agent-session-subscribers'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { scaleDirectory, scaleJournal, scaleRecord } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { countStatusCutWork } from './agent-session-status-cut-work.test-support'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

type Ending =
  | 'quit'
  | 'update'
  | 'crash'
  | 'no-cut'
  | 'command'
  | 'new-request'
  | 'pending'
  | AgentJournalTurnOutcome
async function publicationRig(history: number, sends: number, ending: Ending) {
  const root = await scaleDirectory()
  const record = scaleRecord('cut-session')
  await seedTestAgentSessionRecordStore(root, { records: [record] })
  const store = await openTestAgentSessionRecordStore(root)
  const journal = await scaleJournal(root, record.sessionId)
  const options = { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const identity = (uuid: string): AgentJournalItemIdentity => ({
    provider: 'claude',
    sessionId: 'provider-cut-session-0',
    uuid
  })
  for (let i = 0; i < history; i++) {
    await journal.appendItem(identity(`history-${i}`), hostTestMessage(`old-${i}`), options)
  }
  for (let i = 0; i < sends; i++) {
    await journal.appendSubmission({
      clientMessageId: `send-${i}`,
      payloadFingerprint: `send-${i}`,
      body: hostTestMessage(`sent-${i}`),
      fence: 7
    })
    await journal.resolveDispatch({
      clientMessageId: `send-${i}`,
      state: 'accepted',
      providerIdentity: identity(`send-${i}`),
      fence: 7
    })
  }
  const explicit =
    ending === 'success' ||
    ending === 'failure' ||
    ending === 'cancellation' ||
    ending === 'superseded'
      ? ending
      : undefined
  const turn = await journal.appendItem(
    identity('turn'),
    {
      kind: 'turn',
      turnId: 'cut-turn',
      state: explicit ? 'completed' : 'interrupted',
      startedAt: 10,
      completedAt: 20,
      ...(explicit ? { outcome: explicit } : {})
    },
    options
  )
  if (ending !== 'no-cut') {
    await journal.appendItem(
      {
        provider: 'orca',
        clientMessageId: orcaShutdownRowClientMessageId(record.sessionId, 7, 'generation')
      },
      {
        kind: 'status',
        text: 'Stopped by Orca',
        tone: 'error',
        orcaStop: { cause: ending === 'crash' ? 'crash' : ending === 'update' ? 'update' : 'quit' }
      },
      { fence: 7, turnScope: { kind: 'turn', turnItemId: turn.itemId } }
    )
  }
  if (ending === 'new-request') {
    await journal.appendItem(identity('new-request'), hostTestMessage('next real request'), options)
  }
  if (ending === 'pending') {
    await journal.appendSubmission({
      clientMessageId: 'pending-send',
      payloadFingerprint: 'pending-send',
      body: hostTestMessage('pending request'),
      fence: 7
    })
  }
  if (ending === 'command') {
    const command = await journal.appendItem(
      identity('command'),
      { ...hostTestMessage('/context'), command: { name: 'context' } },
      options
    )
    await journal.appendItem(
      identity('command-turn'),
      {
        kind: 'turn',
        turnId: 'command-turn',
        state: 'completed',
        outcome: 'success',
        userItemId: command.itemId
      },
      options
    )
  }
  const session: StatusFeedSession = {
    journal,
    params: { location: record.location, provider: record.provider },
    operationalRevision: 0,
    child: { phase: 'ready', generation: 'generation', fence: 7 }
  }
  const sessions = new Map<string, StatusFeedSession>()
  const server = new AgentHookServer()
  const sink = agentHookRuntimeDeps(
    server,
    new AgentStatusObservedPaneIdentities(),
    () => ({})
  ).structuredAgentStatusSink
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getConversation: store.getConversation,
    now: () => 1_800_000_000_000,
    logger: createStructuredAgentSessionLogger(),
    statusSink: () => sink
  })
  const events = vi.fn()
  feed.subscribe({ id: 'status', emit: events })
  sessions.set(record.sessionId, session)
  const subscribers = new AgentSessionSubscribers({
    onJournalPublished: (id, source) => feed.publish(id, source)
  })
  const counts = countStatusCutWork()
  const publish = () => subscribers.publish(record.sessionId, journal)
  return {
    record,
    journal,
    store,
    session,
    server,
    feed,
    events,
    counts,
    publish,
    identity,
    options
  }
}

it.each([
  [10, 10],
  [100, 10],
  [10, 100]
])(
  'counts the actual scoped quit reader with H=%i and S=%i, including cache reuse and invalidation',
  async (history, sends) => {
    const rig = await publicationRig(history, sends, 'quit')
    const { counts, publish, events, server, feed, record, journal } = rig
    publish()
    expect(feed.readPublished(record.sessionId)).toMatchObject({
      status: 'idle',
      turnOutcome: 'cancellation',
      statusStartedAt: 20
    })
    expect(server.getStatusSnapshot()[0]?.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'cancellation'
    })
    expect(counts).toMatchObject({
      calls: 1,
      submissions: sends,
      pending: sends,
      indexes: 1,
      commandEntries: 0
    })
    expect(counts.items).toBe(history + sends + 2)
    expect(counts.backward).toBe(2)
    expect(counts.scoped).toBe(counts.items)
    expect(counts.bodyEntries).toBe(counts.items)
    expect(counts.commandVisits).toBe(counts.items)
    expect(counts.scoped).toBeGreaterThan(0)
    expect(counts.backward).toBeGreaterThan(0)
    const readerVisits =
      counts.pending + counts.bodyEntries + counts.commandVisits + counts.backward + counts.scoped
    expect(readerVisits).toBeLessThanOrEqual(4 * counts.items + sends)
    const warm = { ...counts }
    const emitted = events.mock.calls.length
    publish()
    publish()
    expect(counts).toEqual(warm)
    expect(events).toHaveBeenCalledTimes(emitted)
    await rig.store.setConversationName(record.sessionId, 'Renamed after quit')
    publish()
    expect(counts).toEqual(warm)
    await journal.appendItem(
      rig.identity('late-detail'),
      { kind: 'status', text: 'late detail', tone: 'info' },
      rig.options
    )
    const before = events.mock.calls.length
    publish()
    expect(counts.calls).toBe(2)
    const afterJournal = { ...counts }
    publish()
    expect(counts).toEqual(afterJournal)
    // The real row-free owner observation changes cache identity even if outward summary equality suppresses it.
    const beforeWork = events.mock.calls.length
    rig.session.lastEndedChild = { fence: 7, rootGone: true }
    rig.session.operationalRevision = 1
    const sequence = journal.cursor().sequence
    publish()
    expect(journal.cursor().sequence).toBe(sequence)
    expect(counts.calls).toBe(3)
    const afterWork = { ...counts }
    publish()
    expect(counts).toEqual(afterWork)
    expect(events).toHaveBeenCalledTimes(beforeWork)
    expect(beforeWork).toBeGreaterThanOrEqual(before)
    expect(
      counts.bodyEntries + counts.commandVisits + counts.backward + counts.scoped + counts.pending
    ).toBeLessThanOrEqual(4 * counts.items + counts.submissions)
  }
)

it.each([
  ['update', 'idle', 'cancellation', true],
  ['crash', 'idle', 'interruption', true],
  ['no-cut', 'idle', 'interruption', true],
  ['command', 'idle', 'cancellation', true],
  ['new-request', 'idle', 'interruption', true],
  ['pending', 'working', undefined, false],
  ['success', 'idle', 'success', false],
  ['failure', 'idle', 'failure', false],
  ['cancellation', 'idle', 'cancellation', false]
] satisfies [Ending, string, string | undefined, boolean][])(
  'keeps %s outcome scoping through the real publication and canonical sink',
  async (ending, status, outcome, scans) => {
    const { publish, feed, server, record, counts, events } = await publicationRig(10, 10, ending)
    publish()
    expect(feed.readPublished(record.sessionId)).toMatchObject({ status })
    expect(feed.readPublished(record.sessionId)?.turnOutcome).toBe(outcome)
    expect(events).toHaveBeenLastCalledWith({
      type: 'status',
      session: feed.readPublished(record.sessionId)
    })
    const mainAgent = server.getStatusSnapshot()[0]?.mainAgent
    expect(mainAgent?.state === 'done' ? mainAgent.outcome : undefined).toBe(outcome)
    expect(server.getStatusSnapshot()[0]?.mainAgent).toMatchObject({
      state: status === 'working' ? 'working' : 'done',
      ...(outcome ? { outcome } : {})
    })
    expect(counts.indexes).toBe(scans ? 1 : 0)
    if (ending === 'command') {
      expect(counts.commandEntries).toBe(1)
    }
    if (!scans) {
      expect(
        counts.pending + counts.bodyEntries + counts.commandVisits + counts.backward + counts.scoped
      ).toBe(0)
    }
  }
)
