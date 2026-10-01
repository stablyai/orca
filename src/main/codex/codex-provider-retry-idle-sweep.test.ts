// A Codex that keeps reconnecting is working, so the idle sweep must not stop it. Every retry
// frame writes and publishes its own row, and that publish is the activity the sweep reads.
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
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'

const SWEEP_MS = 5
const RETRY_GAP_MS = 10 * 60_000

let root: string
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink | null
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let clock: number

function streamRetry(attempt: number): Record<string, unknown> {
  return {
    threadId: THREAD,
    turnId: 'turn-1',
    willRetry: true,
    error: {
      message: `Reconnecting... ${attempt}/5`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }
    }
  }
}

/** Long enough for many sweep ticks, so "still open" means the sweep declined. */
function waitOutSeveralSweeps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 20))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-retry-sweep-'))
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

describe('a Codex reconnecting a dropped stream', () => {
  it('keeps the conversation open past the idle window while retry frames arrive', async () => {
    expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
      ok: true
    })
    if (!sink) {
      throw new Error('the host never handed the provider its event sink')
    }
    const translator = createCodexJournalTranslator({ sink, primaryThreadId: () => THREAD })

    // Five frames ten minutes apart: fifty minutes, well past the thirty-minute idle window.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      clock += RETRY_GAP_MS
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId: THREAD,
        method: 'error',
        params: streamRetry(attempt)
      })
      await waitOutSeveralSweeps()
      expect(closeSession).not.toHaveBeenCalled()
      expect(host.hasSession(SESSION)).toBe(true)
    }

    const items = host['sessions'].get(SESSION)?.journal.snapshot().items ?? []
    const retryRows = items.filter(
      (item) => item.body.kind === 'status' && item.body.failure?.kind === 'providerRetrying'
    )
    expect(retryRows.map((row) => row.body)).toEqual(
      [1, 2, 3, 4, 5].map((attempt) =>
        expect.objectContaining({
          failure: expect.objectContaining({
            detail: expect.objectContaining({ text: `Reconnecting... ${attempt}/5` })
          })
        })
      )
    )

    // Once the frames stop, the same clock does let the sweep close it.
    clock += STRUCTURED_AGENT_SESSION_IDLE_MS
    await vi.waitFor(() => {
      expect(closeSession).toHaveBeenCalledWith(SESSION, 'evict')
      expect(host.hasSession(SESSION)).toBe(false)
    })
  })
})
