import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../../codex/codex-structured-session-state'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-1'
const TURN_ID = 'turn-1'

function recordingSink() {
  const rows: AgentJournalItemBody[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const activities: (AgentSessionTurnActivity | null)[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => rows.push(body),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn(),
    setActivity: (activity) => activities.push(activity)
  }
  return { sink, rows, tombstones, activities }
}

function codexNotification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function claudeMessage(message: Record<string, unknown>) {
  return { type: 'message' as const, sessionId: SESSION_ID, message }
}

describe('provider turn activity routing', () => {
  it('routes Codex activity without creating protocol rows', () => {
    const state = recordingSink()
    const translator = createCodexJournalTranslator({
      sink: state.sink,
      primaryThreadId: () => THREAD_ID,
      schedule: () => () => {}
    })
    translator.handle(codexNotification('turn/started', { turn: { id: TURN_ID } }))
    const lifecycleRows = state.rows.length

    translator.handle(
      codexNotification('item/mcpToolCall/progress', {
        turnId: TURN_ID,
        itemId: 'mcp-1',
        message: 'Reading the issue context'
      })
    )
    expect(state.rows).toHaveLength(lifecycleRows)
    expect(state.activities.at(-1)).toEqual({
      turnId: TURN_ID,
      text: 'Reading the issue context'
    })

    translator.handle(
      codexNotification('item/started', {
        turnId: TURN_ID,
        item: { type: 'reasoning', id: 'reasoning-1', summary: [], content: [] }
      })
    )
    expect(state.rows).toHaveLength(lifecycleRows)
    expect(state.activities.at(-1)?.text).toBe('Thinking through the request')

    translator.handle(
      codexNotification('item/reasoning/summaryPartAdded', {
        turnId: TURN_ID,
        itemId: 'reasoning-1',
        summaryIndex: 0
      })
    )
    expect(state.activities.at(-1)).toBeNull()
    translator.handle(
      codexNotification('item/reasoning/summaryTextDelta', {
        turnId: TURN_ID,
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: 'Tracing the activity pipeline'
      })
    )
    expect(state.rows).toHaveLength(lifecycleRows)
    expect(state.activities.at(-1)?.text).toBe('Tracing the activity pipeline')
  })

  it('keeps Codex tool rows singular and the activity free of tool labels', () => {
    const state = recordingSink()
    const translator = createCodexJournalTranslator({
      sink: state.sink,
      primaryThreadId: () => THREAD_ID
    })
    translator.handle(codexNotification('turn/started', { turn: { id: TURN_ID } }))
    const lifecycleRows = state.rows.length
    translator.handle(
      codexNotification('item/started', {
        turnId: TURN_ID,
        item: {
          type: 'commandExecution',
          id: 'command-1',
          command: 'pnpm test',
          status: 'inProgress'
        }
      })
    )

    expect(state.rows).toHaveLength(lifecycleRows + 1)
    expect(state.rows.at(-1)).toMatchObject({ kind: 'tool-call', name: 'shell' })
    expect(state.activities.at(-1)).toEqual({ turnId: TURN_ID, text: 'Running a command' })
    expect(state.activities.at(-1)?.text).not.toContain('pnpm test')
  })

  it('routes Claude status frames without creating timeline rows and clears on settlement', () => {
    const state = recordingSink()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle({
      ...claudeMessage({
        type: 'user',
        uuid: TURN_ID,
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'Investigate activity' }] }
      }),
      startsTurn: true
    })
    const turnRows = state.rows.length

    translator.handle(
      claudeMessage({
        type: 'system',
        subtype: 'task_progress',
        summary: 'Checking the renderer state'
      })
    )
    translator.handle(claudeMessage({ type: 'system', subtype: 'status', status: 'compacting' }))
    translator.handle(
      claudeMessage({
        type: 'system',
        subtype: 'control_request_progress',
        status: 'started'
      })
    )
    expect(state.rows).toHaveLength(turnRows)
    expect(state.activities.slice(-3)).toEqual([
      { turnId: TURN_ID, text: 'Checking the renderer state' },
      { turnId: TURN_ID, text: 'Compacting the conversation' },
      { turnId: TURN_ID, text: 'Exploring a side question' }
    ])

    translator.handle(claudeMessage({ type: 'tool_progress', tool_name: 'SecretReader' }))
    expect(state.rows).toHaveLength(turnRows)
    expect(state.activities.at(-1)).toBeNull()

    translator.handle(
      claudeMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Done' })
    )
    expect(state.activities.at(-1)).toBeNull()
    expect(state.tombstones).toHaveLength(1)
  })
})
