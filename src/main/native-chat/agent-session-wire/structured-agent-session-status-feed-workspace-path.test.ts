import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const SESSION = 'session-alpha'
const NOW = 1_800_000_000_000

const FLOATING: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
  workspaceKind: 'folder'
}
const WORKTREE: AgentSessionExecutionLocation = {
  ...FLOATING,
  workspaceId: 'repo-1::/repos/one',
  workspaceKind: 'git-worktree'
}

let root: string
let store: AgentSessionRecordStore
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-feed-workspace-path-'))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function feedFor(location: AgentSessionExecutionLocation) {
  await store.reserveOwner({
    sessionId: SESSION,
    location,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'1'.padStart(32, '0')}`,
      fingerprint: 'fp-1'
    },
    now: NOW
  })
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: location.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, 'journal')
  })
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([[SESSION, { journal, params: { location, provider: 'codex' } }]]),
    getRecord: (sessionId) => store.getRecord(sessionId),
    now: () => NOW
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'renderer', emit: (event) => events.push(event) })
  return { feed, events }
}

function lastSummary(events: readonly AgentSessionStatusEvent[]) {
  const event = events.at(-1)
  if (event?.type === 'status') {
    return event.session
  }
  if (event?.type === 'snapshot') {
    return event.sessions.find((session) => session.sessionId === SESSION)
  }
  throw new Error('no status publication')
}

describe('status feed pinned workspace path', () => {
  it('publishes a floating session its pinned folder once the launch pins it', async () => {
    const { feed, events } = await feedFor(FLOATING)
    expect(lastSummary(events)).toMatchObject({ sessionId: SESSION })
    expect(lastSummary(events)).not.toHaveProperty('workspacePath')

    await store.pinWorkspacePath(SESSION, '/home/me/original-floating')
    feed.publish(SESSION)

    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: { sessionId: SESSION, workspacePath: '/home/me/original-floating' }
    })
  })

  it('carries the pin in the snapshot a later subscriber opens with, as after a restart', async () => {
    const { feed } = await feedFor(FLOATING)
    await store.pinWorkspacePath(SESSION, '/home/me/original-floating')

    const late: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'reloaded-renderer', emit: (event) => late.push(event) })

    expect(lastSummary(late)).toMatchObject({ workspacePath: '/home/me/original-floating' })
  })

  it('omits the pin for a worktree session, whose id is where it launches', async () => {
    const { feed, events } = await feedFor(WORKTREE)
    await store.pinWorkspacePath(SESSION, '/repos/one')
    feed.publish(SESSION)

    expect(lastSummary(events)).toMatchObject({ sessionId: SESSION })
    expect(lastSummary(events)).not.toHaveProperty('workspacePath')
  })
})
