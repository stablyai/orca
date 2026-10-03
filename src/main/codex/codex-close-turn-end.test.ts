// Closing a Codex child settles its open turn in the adapter as interrupted, with no verdict: the
// close names no cause. Whether the end was a person's is the journal's Stop event to say.

import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import {
  closeCodexPublishedSession,
  handleCodexSessionExit
} from './codex-structured-session-close'
import { CodexAcquisitionRegistry, type CodexSession } from './codex-structured-session-state'
import { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'

/** A live Codex child whose primary thread is inside `turn-1`, and what its ended batch wrote. */
function sessionWithRunningTurn() {
  const turnBodies: AgentJournalItemBody[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    tryAppendLifecycleBatch: (_id, mutations) => {
      for (const mutation of mutations) {
        if (mutation.kind === 'item' && mutation.body.kind === 'turn') {
          turnBodies.push(mutation.body)
        }
      }
      return { accepted: true }
    }
  }
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: 'session-1',
    primaryThreadId: () => 'thread-1',
    now: () => 2_000
  })
  translator.handle({
    type: 'notification',
    sessionId: 'session-1',
    threadId: 'thread-1',
    method: 'turn/started',
    params: { turn: { id: 'turn-1' } },
    observedAt: 1_000
  })
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
    historyPath: null,
    prompts: new CodexPromptRegistry(),
    options: new Map(),
    reportedOptions: {},
    fastModeTierByModel: new Map(),
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator
  }
  return { sessions: new Map([['session-1', session]]), session, turnBodies }
}

describe('a Codex close settles the open turn with no verdict of its own', () => {
  // Whose end it was is the journal's Stop event to say (`turnEndAfterStop`), never the close's.
  it('ends it interrupted at the exit, with no outcome', async () => {
    const { sessions, turnBodies } = sessionWithRunningTurn()
    const onEvent = vi.fn()

    await expect(closeCodexPublishedSession(sessions, 'session-1', onEvent)).resolves.toBe(true)

    expect(turnBodies).toEqual([
      expect.objectContaining({ turnId: 'turn-1', state: 'interrupted' })
    ])
    expect(turnBodies[0]).not.toHaveProperty('outcome')
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ended', cause: 'requested-close' })
    )
  })

  it('settles a crash it saw before the close once, as that exit', async () => {
    const { sessions, session, turnBodies } = sessionWithRunningTurn()
    // The child died on its own first; the close then finds it already ended.
    handleCodexSessionExit({
      sessions,
      sessionId: 'session-1',
      connection: session.connection,
      error: new Error('app-server exited')
    })

    await closeCodexPublishedSession(sessions, 'session-1')

    expect(turnBodies).toEqual([
      expect.objectContaining({ turnId: 'turn-1', state: 'interrupted' })
    ])
    expect(turnBodies[0]).not.toHaveProperty('outcome')
  })

  it("settles the same through the adapter's close", async () => {
    const { sessions, turnBodies } = sessionWithRunningTurn()
    const teardown = new CodexStructuredSessionTeardown({
      sessions,
      acquisitions: new CodexAcquisitionRegistry(),
      forgetNotificationRetries: () => {}
    })

    await expect(teardown.close('session-1')).resolves.toBe(true)

    expect(turnBodies).toEqual([
      expect.objectContaining({ turnId: 'turn-1', state: 'interrupted' })
    ])
    expect(turnBodies[0]).not.toHaveProperty('outcome')
  })
})
