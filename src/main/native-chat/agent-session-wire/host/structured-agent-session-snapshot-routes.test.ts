import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import { StructuredAgentSessionSnapshotRoutes } from './structured-agent-session-snapshot-routes'
import { testEventSinkLogging } from './testing/structured-agent-session-logger.test-fixture'

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

it("holds reading across an epoch replacement and resumes only on the new epoch's facts", async () => {
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
  const routes = new StructuredAgentSessionSnapshotRoutes(testEventSinkLogging().logger)
  journal.context.replacements.observe((replaced) =>
    routes.replacing('orca-session', journal, replaced)
  )
  const reading = { pauseReading: vi.fn(), resumeReading: vi.fn() }
  const live = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(),
    readingControl: reading
  })
  const retired = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  await live.followSnapshots(routes.observe('orca-session', journal))
  await retired.followSnapshots(routes.observe('orca-session', journal))
  const saved = {
    canonicalByToolUse: [['toolu_a', 'agent-a']],
    // A saved zero still counts as a first run.
    attemptByAgent: [['agent-a', 1]],
    subagents: [],
    threadGoal: { goal: null, row: null }
  }
  expect(live.sink.journalSnapshot?.()).toEqual(saved)
  retired.close()

  const replaced = journal.replaceEpochItems('handle_forked', 0, [])
  // Reading pauses in the tick the replacement reaches the writer.
  expect(reading.pauseReading).toHaveBeenCalledTimes(1)
  await replaced
  await live.sink.snapshotCurrent?.()

  expect(live.sink.journalSnapshot?.()).toEqual({
    canonicalByToolUse: [],
    attemptByAgent: [],
    subagents: [],
    threadGoal: { goal: null, row: null }
  })
  expect(reading.resumeReading).toHaveBeenCalledTimes(1)
  expect(retired.sink.journalSnapshot?.()).toEqual(saved)
  live.close()
})
