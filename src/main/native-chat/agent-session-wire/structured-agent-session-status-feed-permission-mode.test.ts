import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const SESSION = 'session-alpha'
const NOW = 1_800_000_000_000
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/repos/one',
  workspaceKind: 'git-worktree'
}

let root: string
let store: AgentSessionRecordStore
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-feed-permission-'))
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A Codex chat whose record options are whatever `options` holds when the feed reads it. */
async function feedWithOptions(
  options: { current: Record<string, string> },
  startedIn?: AgentChatPermissionMode
) {
  await store.reserveOwner({
    sessionId: SESSION,
    location: LOCATION,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
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
      workspaceId: LOCATION.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root
  })
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([[SESSION, { journal, params: { location: LOCATION, provider: 'codex' } }]]),
    getRecord: (sessionId) => {
      const record = store.getRecord(sessionId)
      return (
        record && {
          ...record,
          options: options.current,
          ...(startedIn ? { initialPermissionMode: startedIn } : {})
        }
      )
    },
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

it('publishes the mode a chat started in beside its current mode as that changes', async () => {
  const options = { current: { permissionMode: 'auto' } }
  const { feed, events } = await feedWithOptions(options, 'auto')
  expect(lastSummary(events)).toMatchObject({
    status: null,
    initialPermissionMode: 'auto',
    permissionMode: 'auto'
  })

  // Narrowed by a provider without reviewer support, then picked by the user.
  options.current = { permissionMode: 'ask' }
  feed.publish(SESSION)
  expect(lastSummary(events)).toMatchObject({
    initialPermissionMode: 'auto',
    permissionMode: 'ask'
  })
  options.current = { permissionMode: 'bypass' }
  feed.publish(SESSION)

  expect(events.at(-1)).toMatchObject({
    type: 'status',
    session: { initialPermissionMode: 'auto', permissionMode: 'bypass' }
  })
})

it('publishes only the current mode of a record that predates starting modes', async () => {
  const { events } = await feedWithOptions({ current: { permissionMode: 'ask' } })

  expect(lastSummary(events)).toMatchObject({ status: null, permissionMode: 'ask' })
  expect(lastSummary(events)).not.toHaveProperty('initialPermissionMode')
})

it('publishes the mode an older Codex record saved as its reviewer', async () => {
  const { events } = await feedWithOptions({ current: { approvalsReviewer: 'auto_review' } })

  expect(lastSummary(events)).toMatchObject({ permissionMode: 'auto' })
})
