// A Claude that keeps retrying a refused request is working, so the idle sweep must not stop it.
// Every retry frame's publish is the activity the sweep reads, even though a run writes one row.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from '../native-chat/agent-session-wire/structured-agent-session-idle-sweep'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const SWEEP_MS = 5
const RETRY_GAP_MS = 10 * 60_000

let root: string
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink | null
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let clock: number

function apiRetry(attempt: number): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 10,
    retry_delay_ms: 600_000,
    error_status: 429,
    error: 'rate_limit',
    session_id: 'provider-1',
    uuid: `9b2f6a1e-0c4d-4e7a-8f3b-00000000000${attempt}`
  }
}

/** Long enough for many sweep ticks, so "still open" means the sweep declined. */
function waitOutSeveralSweeps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 20))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-retry-sweep-'))
  resetHostTestOperationIds()
  sink = null
  clock = NOW
  closeSession = vi.fn(async () => true)
  const store = await openTestAgentSessionRecordStore(root)
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async ({ fence, spawnToken, events }) => {
      sink = events ?? null
      return {
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW - 1_000, spawnToken },
        acquisitionGeneration: 'generation-1',
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    },
    closeSession,
    releaseAcquisition: async () => true,
    dispatch: async () => ({ state: 'admitted' }),
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined
  }
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    idleSweep: { intervalMs: SWEEP_MS, idleMs: STRUCTURED_AGENT_SESSION_IDLE_MS },
    now: () => clock
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a Claude retrying a refused request', () => {
  it('keeps the conversation open past the idle window while retry frames arrive', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    if (!sink) {
      throw new Error('the host never handed the provider its event sink')
    }
    const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: '1' })

    // Five frames ten minutes apart: fifty minutes, well past the thirty-minute idle window.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      clock += RETRY_GAP_MS
      translator.handle({ type: 'message', sessionId: SESSION, message: apiRetry(attempt) })
      await waitOutSeveralSweeps()
      expect(closeSession).not.toHaveBeenCalled()
      expect(host.hasSession(SESSION)).toBe(true)
    }

    const items = host['sessions'].get(SESSION)?.journal.snapshot().items ?? []
    const retryRows = items.filter(
      (item) => item.body.kind === 'status' && item.body.failure?.kind === 'providerRetrying'
    )
    expect(retryRows).toHaveLength(1)
    expect(retryRows[0]?.body).toMatchObject({
      failure: { detail: { text: expect.stringContaining('"attempt":5') } }
    })

    // Once the frames stop, the same clock does let the sweep close it.
    clock += STRUCTURED_AGENT_SESSION_IDLE_MS
    await vi.waitFor(() => {
      expect(closeSession).toHaveBeenCalledWith(SESSION, 'evict')
      expect(host.hasSession(SESSION)).toBe(false)
    })
  })
})
