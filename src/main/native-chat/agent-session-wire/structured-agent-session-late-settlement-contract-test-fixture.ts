import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'

export const CALLER = { callerKey: 'client-1' }

let root: string

let store: AgentSessionRecordStore

let host: StructuredAgentSessionHost

let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>

export function accepted(): AgentSessionDispatchOutcome {
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
  }
}

export function sendParams(text: string): {
  envelope: AgentSessionMutationEnvelope
  body: ReturnType<typeof hostTestMessage>
} {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  }
}

export async function submissions(): Promise<unknown> {
  const state = await host.history({ sessionId: SESSION, direction: 'tail' })
  return state.ok ? state.page.submissions : null
}

export function journal(): AgentSessionJournal {
  return (
    host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
  ).sessions.get(SESSION)!.journal
}

export async function handedOver(clientMessageId: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(
      journal()
        .submissions()
        .find((entry) => entry.clientMessageId === clientMessageId)?.handedOverAt
    ).toBeDefined()
    expect(dispatch).toHaveBeenCalled()
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-late-settle-'))
  resetHostTestOperationIds()
  dispatch = vi.fn(async () => accepted())
  closeSession = vi.fn(async () => true)
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: startsWhenPublished(
      {
        open: async () => ({
          reportedOptions: { model: '' }
        }),
        acquire: vi.fn(async ({ fence }) => ({
          acquisitionGeneration: globalThis.crypto.randomUUID(),
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
          },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: 'created' as const,
            mintedAtFence: fence,
            observedAt: NOW
          }
        })),
        releaseAcquisition: vi.fn(async () => true),
        dispatch,
        closeSession,
        cancelTurn: vi.fn(async () => ({ cancelled: true })),
        answerPrompt: vi.fn(async () => undefined),
        setOption: vi.fn(async () => undefined)
      },
      () => host
    ),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await host.close(SESSION, 'evict')
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

export const fixture = {
  get closeSession() {
    return closeSession
  },
  set closeSession(value: typeof closeSession) {
    closeSession = value
  },
  get dispatch() {
    return dispatch
  },
  set dispatch(value: typeof dispatch) {
    dispatch = value
  },
  get host() {
    return host
  },
  set host(value: typeof host) {
    host = value
  },
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  },
  get store() {
    return store
  },
  set store(value: typeof store) {
    store = value
  }
}
