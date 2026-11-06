import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
// Exercise durable acceptance before provider delivery through the real host/store/journal.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionHeldStarts } from './structured-agent-session-held-start.test-support'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let adapterExtras: Partial<StructuredAgentSessionAdapter>
let idleMs: number
let clock: number

const spawnChild: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
  process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
  acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
  link: {
    linkId: `link-${fence}`,
    handle: codexProviderHandle(THREAD),
    origin: store.getRecord(SESSION)?.providerHandleChain.length
      ? ('resumed' as const)
      : ('created' as const),
    mintedAtFence: fence,
    observedAt: NOW
  }
})

const starts = structuredAgentSessionHeldStarts(() => host)
void starts.held(spawnChild)

async function startHost(): Promise<void> {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: starts.wrap({
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras,
      open:
        adapterExtras.open ??
        (async () => ({
          reportedOptions: { model: '' }
        }))
    }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    idleSweep: { intervalMs: 5, idleMs: () => idleMs },
    now: () => clock
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-accept-deliver-'))
  resetHostTestOperationIds()
  adapterExtras = {}
  starts.clear()
  idleMs = 60 * 60_000
  clock = NOW
  acquire = vi.fn(spawnChild)
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  await startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

async function writeAsEarlierProcess(
  write: (journal: AgentSessionJournal, fence: number) => Promise<void>
): Promise<void> {
  await host.close(SESSION, 'evict')
  const record = store.getRecord(SESSION)!
  const params = attachParamsForRecord(record, {
    clientOperationId: 'earlier',
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(record, params),
    database: openTestJournalHostDatabase(root)
  })
  await write(journal, record.lease.runtimeFence)
  await journal.close()
}

function earlierSubmission(id: string, text: string, handoverRecorded?: true) {
  const body = hostTestMessage(text)
  return {
    clientMessageId: id,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    }),
    body,
    ...(handoverRecorded ? { handoverRecorded } : {})
  }
}

describe('what an earlier host process left behind', () => {
  it('leaves a legacy pending message and a handed-over one in doubt, never re-sent (W4′c)', async () => {
    await writeAsEarlierProcess(async (journal, fence) => {
      await journal.appendSubmission({ ...earlierSubmission('legacy', 'l'), fence })
      await journal.appendSubmission({ ...earlierSubmission('handed', 'h', true), fence })
      await journal.resolveDispatch({
        clientMessageId: 'handed',
        state: 'pending',
        fence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    })
    await host.flushAllStreamedEvents()
    await startHost()

    await host.revealSession(SESSION)

    expect(await submission('legacy')).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(await submission('handed')).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
