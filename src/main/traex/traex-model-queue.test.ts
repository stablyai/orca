import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionTurnActivity } from '../../shared/agent-session/agent-session-wire'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { TraexSessionAdapter } from './traex-session-adapter'
import { agentJournalTurnBody } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'

let directory: string
let journal: AgentSessionJournal
let adapter: TraexSessionAdapter
let activity: AgentSessionTurnActivity | null

const sessionId = 'trae-queue-contract'

beforeEach(async () => {
  activity = null
  directory = await mkdtemp(join(tmpdir(), 'orca-trae-queue-'))
  const identity = {
    sessionId,
    workspaceId: 'folder-contract',
    hostId: 'local',
    agent: 'trae' as const,
    providerHandle: null
  }
  journal = new AgentSessionJournal({ identity, database: openTestJournalHostDatabase(directory) })
  await journal.open()
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({ sessionId, logger })
  sink.bind({
    journal,
    fence: 1,
    publish: (next) => {
      if (next !== undefined) {
        activity = next
      }
    }
  })
  adapter = new TraexSessionAdapter({
    resolveLaunch: async () => ({
      command: process.execPath,
      args: [join(import.meta.dirname, '__fixtures__', 'traex-scripted-app-server.mjs')],
      cwd: directory,
      previousThreadId: null,
      mayBeUnsaved: false,
      options: {},
      permissionMode: 'ask',
      env: {},
      envToDelete: []
    }),
    onLifecycle: () => {},
    onSettled: () => {}
  })
  const acquisition = await adapter.acquire({
    identity,
    fence: 1,
    spawnToken: randomUUID(),
    events: sink.sink
  })
  await adapter.open({
    sessionId,
    fence: 1,
    acquisitionGeneration: acquisition.acquisitionGeneration,
    signal: new AbortController().signal
  })
})

afterEach(async () => {
  await adapter.closeAll()
  await journal.close()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

function send(text: string) {
  return adapter.dispatch({
    sessionId,
    fence: 1,
    clientMessageId: randomUUID(),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  })
}

it('publishes a pre-start queue position, updates it, and ignores another turn and late queue events', async () => {
  expect((await send('model-queue')).state).toBe('accepted')
  await expect.poll(() => activity?.text).toMatch(/\b12\b/)
  expect(activity?.turnId).toBe('p:thread-trae-contract:turn-1')
  expect((await send('queue-update')).state).toBe('accepted')
  await expect.poll(() => activity?.text).toMatch(/\b3\b/)
  expect((await send('queue-ready')).state).toBe('accepted')
  await expect.poll(() => activity).toBeNull()
  await expect.poll(() => journal.newestTurn()?.state).toBe('completed')
  expect((await adapter.cancelTurn({ sessionId, fence: 1 })).cancelled).toBe(false)
})

it('clears the queue when model output begins even without a ready event', async () => {
  await send('model-queue')
  await expect.poll(() => activity?.text).toMatch(/\b12\b/)
  await send('queue-stream')
  await expect
    .poll(() =>
      journal
        .currentRead()
        .items.some(
          (row) => row.body.kind === 'message' && JSON.stringify(row.body).includes('STREAMING')
        )
    )
    .toBe(true)
  expect(activity).toBeNull()
  expect(journal.newestTurn()?.state).toBe('running')
})

it('clears queue activity when a queued turn is cancelled', async () => {
  await send('model-queue')
  await expect.poll(() => activity?.text).toMatch(/\b12\b/)
  expect((await adapter.cancelTurn({ sessionId, fence: 1 })).cancelled).toBe(true)
  await expect.poll(() => activity).toBeNull()
  await expect.poll(() => journal.newestTurn()?.state).toBe('interrupted')
})

it('ignores queue events for a completed turn restored from history', async () => {
  const identity = createLegacyProviderTimelineIdentityScheme({ agent: 'trae', sessionId }).turn({
    namespace: 'thread-trae-contract',
    key: { source: 'provider', value: 'past-turn' }
  })
  await journal.appendItem(
    identity,
    agentJournalTurnBody({
      turnId: 'p:thread-trae-contract:past-turn',
      state: 'completed'
    }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await send('model-queue-history')
  await expect.poll(() => activity?.text).toMatch(/\b12\b/)
  expect(activity?.turnId).toBe('p:thread-trae-contract:turn-1')
})

it('places compaction queue activity on its command turn and preserves cancellation', async () => {
  const identity = {
    provider: 'legacy' as const,
    agent: 'trae' as const,
    sessionId,
    recordId: 'compact-queue'
  }
  const running = agentJournalTurnBody({ turnId: 'compact-queue', state: 'running' })
  await journal.appendItem(identity, running, { fence: 1, turnScope: { kind: 'thread' } })
  await adapter.compact({
    sessionId,
    fence: 1,
    command: {
      clientMessageId: 'compact-input',
      turnId: 'compact-queue',
      identity,
      resultIdentity: identity,
      running,
      instructions: 'queue-compaction'
    }
  })
  await expect.poll(() => activity?.text).toMatch(/\b12\b/)
  expect(activity?.turnId).toBe('compact-queue')
  expect((await adapter.cancelTurn({ sessionId, fence: 1 })).cancelled).toBe(true)
  await expect.poll(() => activity).toBeNull()
  await expect.poll(() => journal.newestTurn()?.state).toBe('interrupted')
})

it.each([
  ['model-queue-zero', /\b0\b/],
  ['model-queue-unknown', null]
] as const)('keeps queue activity valid for %s', async (input, position) => {
  await send(input)
  await expect.poll(() => activity).not.toBeNull()
  if (position) {
    expect(activity?.text).toMatch(position)
  } else {
    expect(activity?.text.trim()).not.toBe('')
    expect(activity?.text).not.toMatch(/\d/)
  }
})
