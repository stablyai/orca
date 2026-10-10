// A chat that proves its start shows its account can start one, so the model catalog's held
// "can't start" reason is made due for the probe instead of trusted until its TTL runs out.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
const providerStarted = vi.fn()

function startHost(phase: 'ready' | 'starting'): void {
  const acquire: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: 'created' as const,
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: 'generation-1',
    providerChildPhase: phase
  })
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    modelCatalog: {
      read: vi.fn(),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-started-catalog-'))
  resetHostTestOperationIds()
  providerStarted.mockReset()
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

it('a child that proves its start at acquire tells the catalog, with its record', async () => {
  startHost('ready')
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({ ok: true })
  expect(providerStarted).toHaveBeenCalledTimes(1)
  expect(providerStarted.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION })
})

it('a re-attach to the live child proves nothing new and tells the catalog nothing', async () => {
  startHost('ready')
  const params = hostTestAttachParams(null)
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true })
  const fence = store.getRecord(SESSION)?.lease.runtimeFence
  // A reconnecting client replays its attach; the same operation re-attaches the live child.
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
  expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
  expect(providerStarted).toHaveBeenCalledTimes(1)
})

it('a published child tells the catalog only once its start is proven', async () => {
  startHost('starting')
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({ ok: true })
  expect(providerStarted).not.toHaveBeenCalled()
  await host.handleAdapterEvent({
    type: 'started',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: 'generation-1',
    reportedOptions: { model: 'sonnet' },
    restoreSkippedOptions: [],
    optionRevision: 0
  })
  expect(providerStarted).toHaveBeenCalledTimes(1)
})
