import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import { StructuredAgentSessionSnapshotRoutes } from './structured-agent-session-snapshot-routes'
import { testEventSinkLogging } from './testing/structured-agent-session-logger.test-fixture'
import { withTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-snapshot-routes-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const thread = { kind: 'thread' as const }

async function snapshotFixture() {
  const journal = await journals.open({
    identity: {
      sessionId: 'orca-session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9_000,
    stateDirectory: root
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'child' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'working' }] },
    {
      fence: 0,
      turnScope: thread,
      agentId: 'agent-a',
      providerParentRef: 'toolu_a',
      producerKind: 'agent',
      attempt: 0
    }
  )
  const failure = Promise.withResolvers<void>()
  const logging = testEventSinkLogging()
  const routes = new StructuredAgentSessionSnapshotRoutes({
    ...logging.logger,
    warn: () => failure.resolve()
  })
  journal.epochReplacements.observe((replaced) =>
    routes.replacing('orca-session', journal, replaced)
  )
  let paused = false
  const reading = {
    pauseReading: () => {
      paused = true
    },
    resumeReading: () => {
      paused = false
    }
  }
  const live = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(),
    readingControl: reading
  })
  const retired = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  await live.followSnapshots(routes.observe('orca-session', journal))
  await retired.followSnapshots(routes.observe('orca-session', journal))
  expect(live.sink.journalSnapshot?.()).toBeNull()
  live.bind({ journal, fence: 0, publish: () => {} })
  const saved = {
    canonicalByToolUse: [['toolu_a', 'agent-a']],
    // A saved zero still counts as a first run.
    attemptByAgent: [['agent-a', 1]],
    parents: [
      [
        'agent-a',
        [
          [
            'toolu_a',
            expect.objectContaining({
              agentId: 'agent-a',
              providerParentRef: 'toolu_a',
              producerKind: 'agent',
              attempt: 0
            })
          ]
        ]
      ]
    ],
    backgrounds: [],
    subagents: [],
    threadGoal: { goal: null, row: null }
  }
  expect(live.sink.journalSnapshot?.()).toEqual(saved)
  retired.close()
  return { journal, live, retired, saved, failure: failure.promise, paused: () => paused }
}

it("holds reading across an epoch replacement and resumes only on the new epoch's facts", async () => {
  const { journal, live, retired, paused } = await snapshotFixture()
  const replaced = journal.write({
    kind: 'epoch-replace',
    reason: 'handle_forked',
    fence: 0,
    items: []
  })
  // Reading pauses in the tick the replacement reaches the writer.
  expect(paused()).toBe(true)
  await replaced
  await live.sink.snapshotCurrent?.()

  expect(live.sink.journalSnapshot?.()).toEqual({
    canonicalByToolUse: [],
    attemptByAgent: [],
    parents: [],
    backgrounds: [],
    subagents: [],
    threadGoal: { goal: null, row: null }
  })
  expect(paused()).toBe(false)
  expect(retired.sink.journalSnapshot?.()).toBeNull()
  live.close()
})

it('rereads the retained facts after a replacement rolls back before allowing translation', async () => {
  const { journal, live, saved, paused } = await snapshotFixture()
  const before = journal.cursor()
  await withTestAgentSessionDatabase(root, (db) =>
    db.exec(`CREATE TRIGGER reject_snapshot_replacement
      BEFORE UPDATE OF context_boundary ON journal_chat_state
      BEGIN SELECT RAISE(ABORT, 'snapshot_replacement_rollback'); END`)
  )
  try {
    const replaced = journal.write({
      kind: 'epoch-replace',
      reason: 'handle_forked',
      fence: 0,
      items: []
    })
    expect(paused()).toBe(true)
    await expect(replaced).rejects.toThrow('snapshot_replacement_rollback')
    await live.sink.snapshotCurrent?.()
    expect(paused()).toBe(false)
    expect(journal.cursor()).toEqual(before)
    expect(live.sink.journalSnapshot?.()).toEqual(saved)
    expect(await journal.reads.claudeSnapshot()).toEqual(saved)
  } finally {
    live.close()
    await withTestAgentSessionDatabase(root, (db) =>
      db.exec('DROP TRIGGER reject_snapshot_replacement')
    )
  }
})

it('keeps translation held when the replacement commits but its saved facts cannot be reread', async () => {
  const { journal, live, failure, paused } = await snapshotFixture()
  const snapshot = vi
    .spyOn(journal.reads, 'claudeSnapshot')
    .mockRejectedValueOnce(new Error('snapshot read failed'))
  try {
    const replaced = journal.write({
      kind: 'epoch-replace',
      reason: 'handle_forked',
      fence: 0,
      items: []
    })
    expect(paused()).toBe(true)
    let translationAllowed = false
    const waiting = live.sink.snapshotCurrent?.().then(() => {
      translationAllowed = true
    })
    await replaced
    await failure
    expect(paused()).toBe(true)
    expect(translationAllowed).toBe(false)
    expect(live.sink.journalSnapshot?.()).toBeNull()
    expect(await journal.reads.claudeSnapshot()).toEqual({
      canonicalByToolUse: [],
      attemptByAgent: [],
      parents: [],
      backgrounds: [],
      subagents: [],
      threadGoal: { goal: null, row: null }
    })
    live.close()
    await waiting
    expect(translationAllowed).toBe(true)
  } finally {
    snapshot.mockRestore()
    live.close()
  }
})
