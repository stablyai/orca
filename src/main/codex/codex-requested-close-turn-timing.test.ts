import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import { closeCodexPublishedSession } from './codex-structured-session-close'
import type { CodexSession } from './codex-structured-session-state'

afterEach(() => vi.useRealTimers())

describe('requested-close durable turn timing', () => {
  // The exit is observed, so a refused terminal row is the host's to settle, never a reason to
  // keep the dead child indexed for a retry.
  it.each([true, false])(
    'ends the session with its exit receipt though its terminal row is refused (requestedClose=%s)',
    async (requestedClose) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      // Backpressure refuses the terminal row the close's end would write.
      const sink: StructuredAgentSessionEventSink = {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {},
        tryAppendLifecycleBatch: () => ({ accepted: false, reason: 'backpressure' })
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
      const session: CodexSession = {
        connection: {
          pid: 4321,
          closed: false,
          request: async () => ({}),
          notify: () => {},
          respond: () => {},
          respondWithError: () => {},
          close: async () => true
        },
        backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
        ended: false,
        fence: 7,
        acquisitionGeneration: 'generation-1',
        threadId: 'thread-1',
        prompts: new CodexPromptRegistry(),
        options: new Map(),
        reportedOptions: {},
        fastModeTierByModel: new Map(),
        dispatchEchoes: createCodexDispatchEchoes(),
        turnOpenWaits: createCodexTurnOpenWaits(),
        translator
      }
      const sessions = new Map([['session-1', session]])
      const onEvent = vi.fn()

      vi.setSystemTime(2_000)
      await expect(
        closeCodexPublishedSession(sessions, 'session-1', onEvent, { requestedClose })
      ).resolves.toBe(true)
      expect(sessions.has('session-1')).toBe(false)
      expect(session.ended).toBe(true)
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: requestedClose ? 'requested-close' : 'unexpected-exit',
          acquisitionGeneration: 'generation-1',
          observedAt: 2_000
        })
      )
    }
  )
})
