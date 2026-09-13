import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { closeCodexPublishedSession } from './codex-structured-session-close'
import type { CodexSession } from './codex-structured-session-state'

afterEach(() => vi.useRealTimers())

describe('requested-close durable turn timing', () => {
  it.each([true, false])(
    'keeps the first exit receipt when retry requestedClose=%s',
    async (requestedClose) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      const terminalBodies: AgentJournalItemBody[] = []
      let refuseSettlement = true
      const sink: StructuredAgentSessionEventSink = {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {},
        tryAppendLifecycleBatch: (_id, mutations) => {
          if (refuseSettlement) {
            return { accepted: false, reason: 'backpressure' }
          }
          for (const mutation of mutations) {
            if (mutation.kind === 'item') {
              terminalBodies.push(mutation.body)
            }
          }
          return { accepted: true }
        }
      }
      const translator = createCodexJournalTranslator({
        sink,
        sessionId: 'session-1',
        primaryThreadId: () => 'thread-1',
        now: () => Date.now()
      })
      expect(
        translator.handle({
          type: 'notification',
          sessionId: 'session-1',
          threadId: 'thread-1',
          method: 'turn/started',
          params: { turn: { id: 'turn-1' } },
          observedAt: 1_000
        })
      ).toEqual({ accepted: true })
      const session = {
        connection: { close: vi.fn(async () => true) },
        backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
        ended: false,
        requestedClose: false,
        fence: 7,
        acquisitionGeneration: 'generation-1',
        threadId: 'thread-1',
        prompts: { clear: vi.fn() },
        translator
      } as unknown as CodexSession
      const sessions = new Map([['session-1', session]])
      const onEvent = vi.fn()

      vi.setSystemTime(2_000)
      await expect(closeCodexPublishedSession(sessions, 'session-1')).resolves.toBe(false)
      expect(sessions.get('session-1')).toBe(session)
      expect(session.ended).toBe(false)

      refuseSettlement = false
      vi.setSystemTime(60_000)
      await expect(
        closeCodexPublishedSession(sessions, 'session-1', onEvent, {
          expectedAcquisitionGeneration: 'replacement-generation'
        })
      ).resolves.toBe(false)
      expect(onEvent).not.toHaveBeenCalled()
      await expect(
        closeCodexPublishedSession(sessions, 'session-1', onEvent, { requestedClose })
      ).resolves.toBe(true)
      expect(sessions.has('session-1')).toBe(false)
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: requestedClose ? 'requested-close' : 'unexpected-exit',
          acquisitionGeneration: 'generation-1',
          observedAt: 2_000
        })
      )
      expect(terminalBodies.find((body) => body.kind === 'turn')).toMatchObject({
        kind: 'turn',
        state: 'interrupted',
        startedAt: 1_000,
        completedAt: 2_000
      })
    }
  )
})
