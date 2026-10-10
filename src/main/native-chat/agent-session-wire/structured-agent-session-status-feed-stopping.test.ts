// The status feed's Stopping is live state, like the child it rides beside: when the host lets go of
// a session, nothing there is ending the work, so the retained summary no longer says Stopping.

import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const SESSION = 'status-session'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-feed-stopping-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe("the status feed's Stopping", () => {
  it('publishes it while the stopped turn runs, and drops it when the host lets go', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, SESSION)
    })
    const fence = agentSessionRecordFixture().lease.runtimeFence
    const published: AgentSessionStatusSummary[] = []
    const session = indexedStatusFeedSession({
      journal,
      child: { phase: 'ready', generation: 'child-1', fence }
    })
    const feed = new StructuredAgentSessionStatusFeed({
      logger: createStructuredAgentSessionLogger(),
      sessions: new Map([[SESSION, session]]),
      statusSink: () => ({ publish: (summary) => published.push(summary), forget: () => {} }),
      getRecord: () => agentSessionRecordFixture(),
      now: () => 1_000
    })
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1_000 },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    feed.publish(SESSION)
    expect(published.at(-1)).toMatchObject({ status: 'working' })
    expect(published.at(-1)).not.toHaveProperty('stopping')

    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, fence)
    feed.publish(SESSION)
    expect(published.at(-1)).toMatchObject({ status: 'working', stopping: true })

    feed.revokeLive(SESSION)
    expect(published.at(-1)).toMatchObject({ status: 'working' })
    expect(published.at(-1)).not.toHaveProperty('stopping')
  })

  it('reads a turn waiting on the person as attention, never Stopping', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, SESSION)
    })
    const fence = agentSessionRecordFixture().lease.runtimeFence
    const published: AgentSessionStatusSummary[] = []
    const feed = new StructuredAgentSessionStatusFeed({
      logger: createStructuredAgentSessionLogger(),
      sessions: new Map([[SESSION, indexedStatusFeedSession({ journal })]]),
      statusSink: () => ({ publish: (summary) => published.push(summary), forget: () => {} }),
      getRecord: () => agentSessionRecordFixture(),
      now: () => 1_000
    })
    const turn = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1' } as const
    await journal.appendItem(
      { ...turn, ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1_000 },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, fence)
    await journal.appendItem(
      { ...turn, ordinal: 1 },
      {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    feed.publish(SESSION)

    expect(published.at(-1)).toMatchObject({ status: 'attention' })
    expect(published.at(-1)).not.toHaveProperty('stopping')
  })

  it('never says Stopping for a stop that was not a person’s', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, SESSION)
    })
    const fence = agentSessionRecordFixture().lease.runtimeFence
    const published: AgentSessionStatusSummary[] = []
    const feed = new StructuredAgentSessionStatusFeed({
      logger: createStructuredAgentSessionLogger(),
      sessions: new Map([[SESSION, indexedStatusFeedSession({ journal })]]),
      statusSink: () => ({ publish: (summary) => published.push(summary), forget: () => {} }),
      getRecord: () => agentSessionRecordFixture(),
      now: () => 1_000
    })
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1_000 },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    await journal.appendStopEvent({ reason: 'host-stop', turnId: 'turn-1' }, fence)
    feed.publish(SESSION)

    expect(published.at(-1)).toMatchObject({ status: 'working' })
    expect(published.at(-1)).not.toHaveProperty('stopping')
  })
})
