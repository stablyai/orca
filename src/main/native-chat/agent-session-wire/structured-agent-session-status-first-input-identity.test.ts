import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

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
it('visits only new insertion-ordered submissions, even when the host clock steps backward', async () => {
  let clock = 100
  const journal = await open(() => clock)
  const projections = new StructuredAgentSessionJournalProjections()
  await journal.appendSubmission({
    clientMessageId: 'command',
    payloadFingerprint: 'command',
    fence: 7,
    body: command
  })
  const item = vi.spyOn(journal, 'item')
  expect(projections.read(journal, null).firstInputSubmissionKey).toBeNull()
  expect(item).toHaveBeenCalledTimes(1)
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
  expect(journal.snapshot().submissions.map((submission) => submission.clientMessageId)).toEqual([
    'real',
    'command'
  ])
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
})
it('observes a first empty real input without broadcasting an unchanged visible summary', async () => {
  const journal = await open(() => 100)
  const observer = vi.fn()
  const events: AgentSessionStatusEvent[] = []
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([['session', indexedStatusFeedSession({ journal })]]),
    getRecord: () => agentSessionRecordFixture(),
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
