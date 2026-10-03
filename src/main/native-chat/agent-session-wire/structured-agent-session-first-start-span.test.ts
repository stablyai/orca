// The `agentSession.create` span keeps its meaning now that a create starts nothing: it measures a
// chat's first agent start, and no later one.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import * as instrumentation from '../../observability/agent-session-instrumentation'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'
import { startAgentForTests } from './structured-agent-session-attach-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

let root: string
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-first-start-span-'))
  const store = await openTestAgentSessionRecordStore(root)
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('wraps the first start, and its retry after a failure, but no start once an agent has run', async () => {
  const span = vi.spyOn(instrumentation, 'withAgentSessionSpan')
  acquire.mockRejectedValueOnce(new Error('signed out'))

  expect(await host.create({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })
  expect(span).not.toHaveBeenCalled()
  expect(await startAgentForTests(host, SESSION)).toMatchObject({ ok: false })
  // Still the chat's first start: no agent has run it.
  expect(await startAgentForTests(host, SESSION)).toMatchObject({ ok: true })
  expect(span).toHaveBeenCalledTimes(2)

  // Put to rest and started again, as the next message after the idle sweep does.
  await host.collaboratorsForTests().lifetime.stopAgent(SESSION, { cause: 'evict', resting: true })
  expect(await startAgentForTests(host, SESSION)).toMatchObject({ ok: true })
  expect(acquire).toHaveBeenCalledTimes(3)
  expect(span).toHaveBeenCalledTimes(2)
})
