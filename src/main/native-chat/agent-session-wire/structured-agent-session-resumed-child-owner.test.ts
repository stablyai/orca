import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isBackgroundTaskBlock, isSubagentBlock } from '../../../shared/native-chat-types'
import {
  ClaudeBackgroundTaskIdentityResolver,
  writeClaudeBackgroundTaskRow
} from '../../claude/claude-background-task-row-journal'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-stale-state-settlement'
import {
  StructuredAgentSessionSubagentRows,
  type AgentChildWorkRowView
} from './structured-agent-session-subagent-rows'

// A subagent or Claude background task that run 1 started and run 2 resumed is run 2's work: run 1's
// death must not settle it, though its row was created at run 1's fence.

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-resumed-child-owner-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const subagent: AgentChildWorkRowView = {
  id: 'record-1',
  providerId: 'agent-1',
  kind: 'agent',
  description: 'Audit the build',
  state: 'working',
  membership: 'live',
  firstObservedAt: 100,
  observedAt: 100,
  stoppable: true,
  invocation: { invocationId: 'toolu_1', generation: 1 },
  residency: 'background'
}

it('keeps a resumed subagent and background task working when the run that created them dies', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9_000,
    stateDirectory: root
  })
  let fence = 1
  const rows = new StructuredAgentSessionSubagentRows({
    journal: () => journal,
    fence: () => fence,
    currentWork: (_sessionId, open) => new StructuredAgentSessionCurrentWork(open, fence),
    readChildWork: () => [subagent],
    onWriteFailed: (_sessionId, error) => {
      throw error
    }
  })
  const tasks = new ClaudeBackgroundTaskIdentityResolver()
  // One provider process: it reports the subagent and writes the task row through its own sink.
  const run = async () => {
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence, publish: () => {} })
    rows.changed('session-1', deferred.sink)
    writeClaudeBackgroundTaskRow(
      deferred.sink,
      tasks,
      'task-1',
      {
        block: {
          type: 'background-task',
          taskId: 'task-1',
          kind: 'command',
          label: 'Build',
          state: 'working'
        },
        lastSerialized: null,
        toolUseId: 'tool-1',
        terminalNotificationReceived: false,
        generation: 1
      },
      () => AGENT_JOURNAL_THREAD_SCOPE
    )
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    deferred.close()
  }

  const settleRunOne = () =>
    settleStaleStructuredAgentSessionState({
      journal,
      sessionId: 'session-1',
      fence: 2,
      acquisitionGeneration: null,
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'run 1 exited',
        observedAt: 9_000,
        ownerFence: 1
      },
      below: 2
    })
  await run()
  fence = 2
  await run()
  await settleRunOne()
  // A rewind rebuilds the epoch from these rows with both provenance facts, as it stores them.
  await journal.replaceEpochItems(
    'handle_forked',
    2,
    journal.snapshot().items.map((item) => {
      const { ownerFence, executionOwner } = journal.itemProvenance(item.itemId)
      return {
        identity: parseAgentJournalItemKey(item.itemId)!,
        body: journal.itemBody(item.itemId)!,
        ownerFence: ownerFence ?? 0,
        ...(executionOwner === undefined ? {} : { executionOwner })
      }
    })
  )
  await settleRunOne()

  const blocks = journal
    .snapshot()
    .items.flatMap((item) => (item.body.kind === 'message' ? item.body.blocks : []))
  expect(blocks.filter(isSubagentBlock).map((block) => block.state)).toEqual(['working'])
  expect(blocks.filter(isBackgroundTaskBlock).map((block) => block.state)).toEqual(['working'])
})
