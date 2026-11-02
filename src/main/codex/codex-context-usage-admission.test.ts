import { expect, it, vi } from 'vitest'
import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { selectStructuredAgentContextUsage } from '../../shared/agent-session/structured-agent-session-context-usage'

// Captured app-server 0.161.0 shape.
const contextUsage = {
  total: {
    totalTokens: 17611,
    inputTokens: 17606,
    cachedInputTokens: 12288,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0
  },
  last: {
    totalTokens: 17611,
    inputTokens: 17606,
    cachedInputTokens: 12288,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0
  },
  modelContextWindow: 258400
}

it.each(['closed', 'failed', 'replaced'] as const)(
  'settles the selected context refusal through the acquired owner on %s',
  async (boundary) => {
    const r = await checkpointJournalRig()
    r.translator.dispose()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const codex = fakeCodex()
    let readingPaused = false
    const open = codex.openConnection
    codex.openConnection = async (...args) => {
      const connection = await open(...args)
      connection.pauseReading = () => {
        readingPaused = true
      }
      connection.resumeReading = () => {
        readingPaused = false
      }
      return connection
    }
    const events: CodexStructuredSessionEvent[] = []
    const adapter = adapterFor(codex, {}, events)
    const original: StructuredAgentSessionSinkAdmission = {
      accepted: false,
      reason: boundary === 'replaced' ? 'backpressure' : boundary
    }
    const revise = vi.fn<
      NonNullable<StructuredAgentSessionEventSink['tryReviseResolvedItemAndPublish']>
    >(() => original)
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence: 7,
        spawnToken: 'usage-terminal',
        events: r.deferred.sink
      })
      const connection = codex.connections[0]
      connection.handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'turn' }
      })
      await r.deferred.drained()
      r.deferred.sink.tryReviseResolvedItemAndPublish = revise
      const publishedContext: unknown[] = []
      r.publish.mockImplementation(() => {
        publishedContext.push(selectStructuredAgentContextUsage(r.journal.snapshot().items))
      })
      connection.handlers.onNotification?.('thread/tokenUsage/updated', {
        threadId: THREAD_ID,
        turnId: 'turn',
        tokenUsage: contextUsage
      })
      if (boundary === 'replaced') {
        expect(readingPaused).toBe(true)
        await vi.advanceTimersByTimeAsync(25)
        await acquireReadyCodexForTest(adapter, {
          identity: identityFor('session-1'),
          fence: 8,
          spawnToken: 'usage-successor'
        })
      }
      await vi.advanceTimersByTimeAsync(100)
      expect(revise.mock.results.every((result) => result.value === original)).toBe(true)
      expect(revise).toHaveBeenCalled()
      expect(connection.closeCount).toBe(1)
      expect(readingPaused).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        events.filter(
          (event) => event.type === 'notification' && event.method === 'thread/tokenUsage/updated'
        )
      ).toEqual([])
      expect(publishedContext.filter((value) => value !== null)).toEqual([])
      expect(selectStructuredAgentContextUsage(r.journal.snapshot().items)).toBeNull()
      if (boundary === 'replaced') {
        expect(codex.connections[1].closeCount).toBe(0)
        expect(adapter.backgroundTaskStops('session-1')).toBeDefined()
      } else {
        expect(events.filter((event) => event.type === 'ended')).toMatchObject([
          {
            reason: `notification admission failed (${boundary})`,
            fence: 7,
            acquisitionGeneration: 'generation-1'
          }
        ])
        expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
      }
    } finally {
      await adapter.closeAll()
      await closeCheckpointTestJournals()
      vi.useRealTimers()
    }
  }
)
