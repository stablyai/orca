import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session/agent-session-wire'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'

const journals = createTrackedJournalOpener()
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-first-input-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(directory, { recursive: true, force: true })
})
async function open(now: () => number) {
  return journals.open({
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('provider')
    },
    stateDirectory: directory,
    now
  })
}
const command = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [],
  command: { name: 'compact' }
}
it.each([10, 100])('scopes %i old commands incrementally across clear', async (count) => {
  let clock = 100
  const journal = await open(() => clock)
  const projections = new StructuredAgentSessionJournalProjections()
  for (let index = 0; index < count; index++) {
    await journal.appendSubmission({
      clientMessageId: `command-${index}`,
      payloadFingerprint: 'command',
      fence: 7,
      body: command
    })
  }
  const item = vi.spyOn(journal, 'item')
  const floor = vi.spyOn(journal.context, 'floor')
  expect(projections.read(journal, null).firstInputSubmissionKey).toBeNull()
  expect(item).toHaveBeenCalledTimes(count)
  expect(floor).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 12; index++) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'provider', turnId: 'compact', ordinal: index },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `Output ${index}` }] },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    item.mockClear()
    expect(projections.read(journal, null).firstInputSubmissionKey).toBeNull()
    expect(item).not.toHaveBeenCalled()
  }
  clock = 99
  await journal.appendSubmission({
    clientMessageId: 'real',
    payloadFingerprint: 'real',
    fence: 7,
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  expect(journal.snapshot().submissions[0]?.clientMessageId).toBe('real')
  item.mockClear()
  expect(projections.read(journal, null).firstInputSubmissionKey).toBe(
    JSON.stringify([journal.cursor().epoch, 'real'])
  )
  expect(item).toHaveBeenCalledTimes(1)
  await journal.appendSubmission({
    clientMessageId: 'later',
    payloadFingerprint: 'later',
    fence: 7,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Later' }] }
  })
  item.mockClear()
  expect(projections.read(journal, null).firstInputSubmissionKey).toBe(
    JSON.stringify([journal.cursor().epoch, 'real'])
  )
  expect(item).not.toHaveBeenCalled()
  const boundary = { operationId: 'clear', afterFence: 7, clearedAt: 101 }
  await journal.context.clear(boundary, { write: () => {}, committed: () => {} })
  const record = agentSessionConversationView({
    ...agentSessionRecordFixture(),
    providerContextBoundary: boundary
  })
  item.mockClear()
  floor.mockClear()
  expect(projections.read(journal, record).firstInputSubmissionKey).toBeNull()
  expect(item).toHaveBeenCalledTimes(count + 2)
  expect(floor).toHaveBeenCalledTimes(1)
  await journal.appendSubmission({
    clientMessageId: 'maintenance',
    payloadFingerprint: 'maintenance',
    fence: 7,
    body: command
  })
  expect(projections.read(journal, record).firstInputSubmissionKey).toBeNull()
  item.mockClear()
  expect(projections.read(journal, record).firstInputSubmissionKey).toBeNull()
  expect(item).not.toHaveBeenCalled()
  await journal.appendSubmission({
    clientMessageId: 'fresh',
    payloadFingerprint: 'fresh',
    fence: 7,
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  item.mockClear()
  expect(projections.read(journal, record).firstInputSubmissionKey).toBe(
    JSON.stringify([journal.cursor().epoch, 'fresh'])
  )
  expect(item).toHaveBeenCalledTimes(1)
})
it('observes a first empty real input without broadcasting an unchanged visible summary', async () => {
  const journal = await open(() => 100)
  const observer = vi.fn()
  const events: AgentSessionStatusEvent[] = []
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([['session', indexedStatusFeedSession({ journal })]]),
    getConversation: () => agentSessionConversationView(agentSessionRecordFixture()),
    now: () => 100,
    logger: createStructuredAgentSessionLogger(),
    onStatusChanged: observer
  })
  feed.subscribe({ id: 'sidebar', emit: (event) => events.push(event) })
  await journal.appendSubmission({
    clientMessageId: 'command',
    payloadFingerprint: 'command',
    fence: 7,
    body: command
  })
  feed.publish('session')
  expect(observer.mock.calls.at(-1)?.[1]).toMatchObject({ firstInputSubmissionKey: null })
  const count = events.length
  await journal.appendSubmission({
    clientMessageId: 'empty',
    payloadFingerprint: 'empty',
    fence: 7,
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  feed.publish('session')
  expect(observer.mock.calls.at(-1)?.[1]).toMatchObject({
    replay: false,
    firstInputSubmissionKey: JSON.stringify([journal.cursor().epoch, 'empty'])
  })
  expect(events).toHaveLength(count)
  const observed = observer.mock.calls.length
  feed.publish('session')
  expect(observer).toHaveBeenCalledTimes(observed)
})

it('retains historical status evidence and exact digested attribution across logical cuts and reopen', async () => {
  let clock = 100
  let journal = await open(() => clock)
  const projections = new StructuredAgentSessionJournalProjections()
  const body: AgentJournalMessageItem = { kind: 'message', role: 'user', blocks: [] }
  const check = () => {
    const full = journal.snapshot()
    const bounded = journal.statusRead()
    expect(bounded.items).toEqual(full.items)
    expect(projectStructuredAgentSessionStatusState(bounded.items, bounded.submissions, 7)).toEqual(
      projectStructuredAgentSessionStatusState(full.items, full.submissions, 7)
    )
    expect(newestAcceptedSendKey(journal.epoch, bounded.submissions)).toBe(
      newestAcceptedSendKey(journal.epoch, full.submissions)
    )
    return full
  }
  const oversized = 'original-'.repeat(200)
  for (const id of [oversized, 'equal-clock-second']) {
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: id,
      fence: 7,
      body,
      handoverRecorded: true
    })
    await journal.resolveDispatch({
      clientMessageId: id,
      state: 'accepted',
      providerIdentity: { provider: 'orca', clientMessageId: `echo-${id}` },
      fence: 7
    })
    expect(journal.inputOrder.inputForItem(agentJournalSubmissionKey(id))?.clientMessageId).toBe(id)
    check()
  }
  expect(newestAcceptedSendKey(journal.epoch, journal.statusRead().submissions)).toBe(
    `${journal.epoch}:equal-clock-second`
  )
  await journal.replaceEpochItems('unreconcilable_prefix', 7, [])
  expect(check().submissions).toHaveLength(2)
  expect(projections.read(journal, null).state.summary.status).toBe('idle')
  expect(projections.read(journal, null).firstInputSubmissionKey).toBeNull()
  // A self-started turn keeps its user's steer relationship after that input item is removed.
  const turn = { provider: 'orca', clientMessageId: 'self-started' } as const
  await journal.appendItem(
    turn,
    {
      kind: 'status',
      text: 'Done',
      turnLifecycle: {
        turnId: 'self-started',
        userItemId: agentJournalSubmissionKey('self-started'),
        state: 'completed',
        outcome: 'success',
        completedAt: 110
      }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  clock = 105
  await journal.appendSubmission({
    clientMessageId: 'steer',
    payloadFingerprint: 'steer',
    fence: 7,
    body,
    handoverRecorded: true
  })
  await journal.resolveDispatch({
    clientMessageId: 'steer',
    state: 'rejected',
    reason: 'provider ended the steered input',
    answeredInTurn: { turn, via: 'steer' },
    fence: 7
  })
  await journal.appendTombstone({ provider: 'orca', clientMessageId: 'steer' }, { fence: 7 })
  check()
  expect(projections.read(journal, null).state.latestRequest?.selfStarted).toBeUndefined()
  const boundary = { operationId: 'clear-history', afterFence: 7, clearedAt: 120 }
  await journal.context.clear(boundary, { write: () => {}, committed: () => {} })
  check()
  clock = 125
  await journal.appendSubmission({
    clientMessageId: 'refused',
    payloadFingerprint: 'refused',
    fence: 7,
    body,
    handoverRecorded: true
  })
  await journal.resolveDispatch({
    clientMessageId: 'refused',
    state: 'rejected',
    reason: 'provider refused the request',
    fence: 7
  })
  check()
  await journals.closeAll()
  journal = await open(() => clock)
  expect(check().submissions.map((entry) => entry.clientMessageId)).toEqual([
    oversized,
    'equal-clock-second',
    'steer',
    'refused'
  ])
  expect(
    journal.inputOrder.inputForItem(agentJournalSubmissionKey(oversized))?.clientMessageId
  ).toBe(oversized)
})
