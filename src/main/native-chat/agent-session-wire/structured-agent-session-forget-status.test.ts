// Removing a session from the host's map and removing its status row are ONE operation.
//
// The store keeps a row until told to drop it, and `structuredHostOwned` bypasses the staleness
// check in `agent-status-freshness.ts` — so a deletion path that skipped the forget leaves a
// permanently `working` agent in `worktree ps` and on mobile, with no UI able to clear it.
//
// This drives the real orchestration closure for the failed attach, against the real store.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { AgentHookServer } from '../../agent-hooks/server'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

// Everything before the journal is out of scope here; what matters is that the orchestration's
// own `onAttachFailed` runs, which is the real one.
vi.mock('./structured-agent-session-attach-flow', () => ({
  performAttach: async (input: { onAttachFailed?: () => Promise<void> }) => {
    await input.onAttachFailed?.()
    throw new Error('attach failed after acquisition')
  }
}))

const SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const TURN = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 } as const
const PROMPT = { ...TURN, ordinal: 1 }

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'repo-1::/workspace/app',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: SESSION }
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-forget-status-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A session the store already lists as a host-owned working agent. */
async function workingSession(): Promise<{
  server: AgentHookServer
  feed: StructuredAgentSessionStatusFeed
  sessions: Map<string, StructuredAgentSessionHostSession>
  journal: AgentSessionJournal
}> {
  const journal = await journals.open({ identity: IDENTITY, journalDir: join(root, SESSION) })
  await journal.appendItem(
    PROMPT,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ship it' }] },
    { fence: 1 }
  )
  await journal.appendItem(
    TURN,
    { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
    { fence: 1 }
  )
  const sessions = new Map<string, StructuredAgentSessionHostSession>([
    [
      SESSION,
      {
        journal,
        params: { location: { workspaceId: IDENTITY.workspaceId }, provider: 'codex' },
        fence: 1,
        hasProviderChild: true,
        acquisitionGeneration: null
      } as unknown as StructuredAgentSessionHostSession
    ]
  ])
  const server = new AgentHookServer()
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: () => null,
    now: () => 1,
    statusSink: () => ({
      publish: (summary) => server.ingestStructuredStatus(summary),
      forget: (sessionId) => server.dropStructuredStatus(sessionId)
    })
  })
  feed.publish(SESSION, journal)
  expect(server.getStatusSnapshot()).toEqual([
    expect.objectContaining({ state: 'working', structuredHost: 'owned' })
  ])
  return { server, feed, sessions, journal }
}

function attachContext(
  sessions: Map<string, StructuredAgentSessionHostSession>,
  feed: StructuredAgentSessionStatusFeed
): StructuredAgentSessionAttachContext {
  const eventSink = {
    sink: {},
    drained: async () => ({ ok: true }) as const,
    unbind: () => undefined,
    bind: () => undefined,
    close: () => undefined
  }
  return {
    deps: { store: { getRecord: () => null }, claimKeyId: 'key-1', journalRoot: root },
    runtimeState: {
      resolveRecovery: async () => undefined,
      eventSinkFor: () => eventSink,
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      discardEventSink: () => undefined
    },
    sessions,
    subscribers: { reset: () => undefined, snapshot: () => undefined, publish: () => undefined },
    tasks: { trackAttach: <T>(task: Promise<T>) => task },
    reconcileLeases: async () => null,
    serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
    now: () => 1,
    forgetStatus: (sessionId: string) => feed.forget(sessionId)
  } as unknown as StructuredAgentSessionAttachContext
}

const attachParams = {
  envelope: { sessionId: SESSION, clientOperationId: 'op-1' }
} as unknown as Parameters<typeof attachStructuredAgentSession>[2]

describe('a session that leaves the host without an explicit close', () => {
  it('leaves the agent-status store with it when an attach fails', async () => {
    const { server, feed, sessions } = await workingSession()

    await expect(
      attachStructuredAgentSession(attachContext(sessions, feed), 'caller-1', attachParams)
    ).rejects.toThrow('attach failed after acquisition')

    expect(sessions.has(SESSION)).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  // The feed's own cache deliberately retains the projection for reload history; only the store
  // is a roster, which is why the forget has to be explicit rather than derived from the cache.
  it('keeps the projection a reloading renderer still needs', async () => {
    const { feed, sessions } = await workingSession()

    await expect(
      attachStructuredAgentSession(attachContext(sessions, feed), 'caller-1', attachParams)
    ).rejects.toThrow('attach failed after acquisition')

    const events: unknown[] = []
    feed.subscribe({ id: 'list-late', emit: (event) => events.push(event) })
    expect(events).toEqual([
      { type: 'snapshot', sessions: [expect.objectContaining({ sessionId: SESSION })] }
    ])
  })
})
