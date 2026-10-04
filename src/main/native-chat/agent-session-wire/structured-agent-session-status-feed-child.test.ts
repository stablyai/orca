import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const SESSION = 'status-session'
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-child-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('publishes the provider child startup phase, not which child it is', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    stateDirectory: root
  })
  const sessions = new Map<string, ReturnType<typeof indexedStatusFeedSession>>()
  const setChild = (
    child: {
      phase: 'starting' | 'ready'
      generation: string
      fence: number
    } | null
  ) => sessions.set(SESSION, indexedStatusFeedSession({ journal, child }))
  setChild({ phase: 'starting', generation: 'child-1', fence: 1 })
  const events: AgentSessionStatusEvent[] = []
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions,
    getRecord: () => null,
    now: () => 1
  })
  const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  expect(events.at(-1)).toMatchObject({
    type: 'snapshot',
    sessions: [{ hostExecutionOwned: true, hostExecutionPhase: 'starting' }]
  })
  const published = events.length
  setChild({ phase: 'starting', generation: 'child-2', fence: 2 })
  feed.publish(SESSION, journal)
  // A replacement child no session list can tell apart is not re-sent to every subscriber.
  expect(events).toHaveLength(published)
  setChild({ phase: 'ready', generation: 'child-2', fence: 2 })
  feed.publish(SESSION, journal)
  expect(events.at(-1)).toMatchObject({ session: { hostExecutionPhase: 'ready' } })
  setChild(null)
  feed.publish(SESSION, journal)
  expect(events.at(-1)).not.toMatchObject({ session: { hostExecutionPhase: expect.any(String) } })
  dispose()
})
