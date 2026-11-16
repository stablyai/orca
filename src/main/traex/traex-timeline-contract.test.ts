import { openTestAgentSessionDatabase } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { readTestJournalItems } from '../native-chat/agent-session-journal/journal-observation.test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { TraexTimeline } from './traex-timeline'
import { projectTraexHistoryTurn } from './traex-history-projection'

let directory: string
let journal: AgentSessionJournal
let timeline: TraexTimeline
let written: () => Promise<unknown>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-trae-stream-'))
  const identity = {
    sessionId: 'trae-stream',
    workspaceId: 'folder-contract',
    hostId: 'local',
    agent: 'trae' as const,
    providerHandle: null
  }
  journal = await AgentSessionJournal.open({
    identity,
    database: await openTestAgentSessionDatabase(directory)
  })
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger
  })
  sink.bind({ journal, fence: 1, publish: () => {} })
  written = sink.drained
  timeline = new TraexTimeline({
    sessionId: identity.sessionId,
    threadId: 'thread-stream',
    generation: 'stream-generation',
    sink: sink.sink,
    fail: (error) => {
      throw error
    }
  })
  timeline.apply({ type: 'turn.open', turn: 'turn-stream', at: 100000 })
})

afterEach(async () => {
  timeline.dispose()
  await journal.close()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

function notify(method: string, params: Record<string, unknown>): void {
  timeline.notification(method, { threadId: 'thread-stream', ...params }, 'turn-stream')
  timeline.flush()
}

it('keeps persistent command output live after its initiating turn finishes', async () => {
  notify('item/started', {
    item: {
      id: 'background-command',
      type: 'commandExecution',
      source: 'unifiedExecStartup',
      status: 'inProgress',
      command: 'sleep 30',
      processId: 'pty-background'
    }
  })
  notify('item/commandExecution/outputDelta', { itemId: 'background-command', delta: 'BEFORE\n' })
  timeline.apply({
    type: 'turn.end',
    turn: 'turn-stream',
    at: 101000,
    state: 'completed',
    outcome: 'success'
  })
  const command = async () => {
    await written()
    return (await readTestJournalItems(journal)).find(
      (row) => row.body.kind === 'tool-call' && row.body.callId === 'background-command'
    )!.body
  }
  expect(await command()).toMatchObject({ state: 'running', output: { head: 'BEFORE\n' } })
  notify('item/commandExecution/outputDelta', { itemId: 'background-command', delta: 'AFTER\n' })
  notify('item/completed', {
    item: { id: 'background-command', type: 'commandExecution', status: 'completed', exitCode: 0 }
  })
  expect(await command()).toMatchObject({ state: 'completed', output: { head: 'BEFORE\nAFTER\n' } })
})

it('separates streamed reasoning parts before the final snapshot arrives', async () => {
  notify('item/reasoning/summaryTextDelta', { itemId: 'reasoning', delta: 'First' })
  notify('item/reasoning/summaryPartAdded', { itemId: 'reasoning', summaryIndex: 1 })
  notify('item/reasoning/summaryTextDelta', { itemId: 'reasoning', delta: 'Second' })
  await written()
  expect(
    (await readTestJournalItems(journal)).find(
      (row) => row.body.kind === 'message' && row.body.role === 'reasoning'
    )?.body
  ).toMatchObject({ blocks: [{ type: 'text', text: 'First\nSecond' }] })
})

it('restores the provider-reported duration with a saved turn', () => {
  const rows = projectTraexHistoryTurn({
    threadId: 'thread-history',
    sessionId: 'trae-history',
    epoch: 'history-epoch',
    turn: {
      id: 'saved-turn',
      status: 'completed',
      startedAt: 100,
      completedAt: 102,
      durationMs: 1500,
      items: []
    }
  })
  expect(rows.find((row) => row.body.kind === 'turn')?.body).toMatchObject({
    startedAt: 100000,
    completedAt: 102000,
    durationMs: 1500
  })
})
