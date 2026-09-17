import { describe, expect, it } from 'vitest'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-1'
const TURN_ID = 'turn-1'

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function terminalDispatchScenario(): {
  echoes: ReturnType<typeof createCodexDispatchEchoes>
  appendOptions: () => StructuredAgentSessionAppendOptions | undefined
} {
  const echoes = createCodexDispatchEchoes()
  echoes.arm('client-1')
  echoes.bindSteerResponse('client-1', TURN_ID, TURN_ID)
  let options: StructuredAgentSessionAppendOptions | undefined
  const sink: StructuredAgentSessionEventSink = {
    durableLifecycleCallbacks: true,
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    appendLifecycleBatch: (_settlementId, _mutations, received) => {
      options = received
      return { accepted: true }
    }
  }
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => THREAD_ID,
    dispatchEchoes: echoes
  })

  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
  translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
  return { echoes, appendOptions: () => options }
}

describe('Codex terminal dispatch durability', () => {
  it('retires terminal ownership only after the lifecycle append commits', () => {
    const { echoes, appendOptions } = terminalDispatchScenario()
    expect(echoes.size).toBe(1)

    appendOptions()?.onCommitted?.()

    expect(echoes.size).toBe(0)
    expect(echoes.settle('client-1')).toBe(true)
  })

  it('keeps echo recovery live when the lifecycle append is abandoned', () => {
    const { echoes, appendOptions } = terminalDispatchScenario()

    appendOptions()?.onAbandoned?.()

    expect(echoes.size).toBe(1)
    expect(echoes.settle('client-1')).toBe(true)
  })
})
