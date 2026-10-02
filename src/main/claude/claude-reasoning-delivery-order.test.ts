// What a client sees, delivery by delivery, when a Claude turn ends in an error result with a
// thinking block still open: real translator, sink queue, journal, subscribers and reducer.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  nativeChatReasoningGate,
  nativeChatReasoningGateKey
} from '../../shared/native-chat-reasoning-row'
import type { AgentSessionTurnActivity as LiveActivity } from '../../shared/agent-session-turn-activity'
import { activeStructuredAgentSessionTurnId } from '../../shared/structured-agent-session-live-turn'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../shared/structured-agent-session-reducer'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { AgentSessionSubscribers } from '../native-chat/agent-session-wire/structured-agent-session-subscribers'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

/** The host's live reasoning gate, as a client reads it. */
const reasoningOpen = (
  activity: LiveActivity | null | undefined,
  liveTurnId: string | null,
  agentId?: string
): boolean => nativeChatReasoningGate(nativeChatReasoningGateKey(activity, liveTurnId))(agentId)

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

/** Every delivery's view: whether a running reasoning row in the live turn draws with the gate shut. */
async function clientViews() {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-delivery-'))
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: 's',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
    },
    database: openTestJournalHostDatabase(root),
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  cleanups.push(async () => {
    deferred.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })
  let state: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  const shownOpenWithGateShut: number[] = []
  const subscribers = new AgentSessionSubscribers({ now: () => 1_000 })
  subscribers.open({
    id: 'client',
    sessionId: 's',
    journal,
    fence: 1,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      state = reduceStructuredAgentSession(state, {
        type: 'event',
        event: JSON.parse(JSON.stringify(event))
      })
      const live = activeStructuredAgentSessionTurnId(state.items)
      const running = state.items.some(
        (item) =>
          item.body.kind === 'message' &&
          item.body.role === 'reasoning' &&
          item.body.state === 'running'
      )
      if (live && running && !reasoningOpen(state.activity, live)) {
        shownOpenWithGateShut.push(state.items.length)
      }
    }
  })
  deferred.bind({
    journal,
    fence: 1,
    publish: (activity) => subscribers.publish('s', journal, activity)
  })
  const translator = createClaudeJournalTranslator({
    sink: deferred.sink,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const frame = async (message: Record<string, unknown>, observedAt: number) => {
    translator.handle({
      type: 'message',
      sessionId: 's',
      observedAt,
      message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
    })
    await deferred.drained()
  }
  return { frame, shownOpenWithGateShut, state: () => state }
}

describe('a thinking block cut off by an error result', () => {
  it('never shows the open row with the gate already shut', async () => {
    const { frame, shownOpenWithGateShut, state } = await clientViews()
    const stream = (uuid: string, event: Record<string, unknown>, at: number) =>
      frame({ type: 'stream_event', uuid, event }, at)
    await stream('start', { type: 'message_start', message: { id: 'message-1' } }, 1_000)
    await stream(
      'block',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      1_010
    )
    await stream(
      'delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Weighing the inventory design' }
      },
      2_000
    )
    // Shaped as captured: an error_during_execution result with no final frame for the block.
    await frame(
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'DONE',
        uuid: 'result-1'
      },
      9_000
    )
    expect(shownOpenWithGateShut).toEqual([])
    expect(
      state().items.find((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
        ?.body
    ).toMatchObject({ state: 'completed', completedAt: 9_000 })
  })
})
