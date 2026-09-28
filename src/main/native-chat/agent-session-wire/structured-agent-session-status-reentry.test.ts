import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { AgentHookServer } from '../../agent-hooks/server'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'

const SESSION = 'reenter-session'
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-reentry-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function openJournal(): Promise<AgentSessionJournal> {
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
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    { fence: 1 }
  )
  return journal
}

async function createFeed() {
  const journal = await openJournal()
  const session = indexedStatusFeedSession({ journal })
  const sessions = new Map<
    string,
    {
      journal: AgentSessionJournal
      params: { location: AgentSessionExecutionLocation; provider: 'codex' }
    }
  >([[SESSION, session]])
  const server = new AgentHookServer()
  const statusSink: StructuredAgentSessionStatusSink = {
    publish: vi.fn((summary, subject) => server.ingestStructuredStatus(summary, subject)),
    forget: vi.fn((subject) => server.dropStructuredStatus(subject))
  }
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: () => null,
    now: () => 1_000,
    statusSink: () => statusSink
  })
  feed.publish(SESSION)
  expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(1)
  return { session, sessions, server, statusSink, feed }
}

describe('structured status canonical owner re-entry', () => {
  it('re-admits an unchanged session after its exact subject was forgotten', async () => {
    const { session, sessions, server, statusSink, feed } = await createFeed()
    sessions.delete(SESSION)
    feed.forget(SESSION)
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
    const publishedBeforeReentry = vi.mocked(statusSink.publish).mock.calls.length
    sessions.set(SESSION, session)

    feed.publish(SESSION)

    expect(statusSink.publish).toHaveBeenCalledTimes(publishedBeforeReentry + 1)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(1)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: expect.any(String), prompt: 'hello' })
    ])
  })

  it('moves an unchanged projection to a new trusted execution scope', async () => {
    const { session, sessions, server, statusSink, feed } = await createFeed()
    sessions.set(SESSION, {
      ...session,
      params: {
        ...session.params,
        location: { ...session.params.location, executionHostId: 'ssh:second-host' }
      }
    })

    feed.publish(SESSION)

    expect(statusSink.forget).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executionHostId: 'local', sessionId: SESSION })
    )
    expect(statusSink.publish).toHaveBeenCalledTimes(2)
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ executionHostId: 'ssh:second-host' })
      })
    ])
  })
})
