import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'

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

it('publishes each provider child even when a replacement has the same startup phase', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, SESSION)
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
    sessions,
    getRecord: () => null,
    now: () => 1
  })
  const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  expect(events.at(-1)).toMatchObject({
    type: 'snapshot',
    sessions: [
      {
        hostExecutionOwned: true,
        hostExecutionPhase: 'starting',
        hostExecutionChild: { generation: 'child-1', fence: 1 }
      }
    ]
  })
  setChild({ phase: 'starting', generation: 'child-2', fence: 2 })
  feed.publish(SESSION, journal)
  expect(events.at(-1)).toMatchObject({
    session: {
      hostExecutionPhase: 'starting',
      hostExecutionChild: { generation: 'child-2', fence: 2 }
    }
  })
  setChild({ phase: 'ready', generation: 'child-2', fence: 2 })
  feed.publish(SESSION, journal)
  expect(events.at(-1)).toMatchObject({ session: { hostExecutionPhase: 'ready' } })
  setChild(null)
  feed.publish(SESSION, journal)
  expect(events.at(-1)).not.toMatchObject({ session: { hostExecutionPhase: expect.any(String) } })
  expect(events.at(-1)).not.toMatchObject({ session: { hostExecutionChild: expect.any(Object) } })
  dispose()
})
