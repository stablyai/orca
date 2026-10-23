import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { claudeChildOperation, drainClaudeChildWork } from './claude-child-work-evidence'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { claudeToolResults, readClaudeMessageEnvelope } from './claude-structured-item-translation'

function frame(content: unknown, parentToolUseId: string | null): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'result-frame',
    session_id: 'provider',
    parent_tool_use_id: parentToolUseId,
    message: { role: 'user', content }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Claude child operation output retention', () => {
  it('reads child traffic after journaling a large result without joining the output again', () => {
    const first = 'a'.repeat(25 * 1024 * 1024)
    const second = 'b'.repeat(25 * 1024 * 1024)
    const message = frame(
      [
        {
          type: 'tool_result',
          tool_use_id: 'child-call',
          content: [
            { type: 'text', text: first },
            { type: 'text', text: second }
          ]
        }
      ],
      'parent'
    )
    const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (identity, body) => items.push({ identity, body }),
      appendTombstone: () => {},
      publish: () => {}
    }
    const translator = createClaudeJournalTranslator({ sink })
    try {
      translator.handle({ type: 'message', sessionId: 'orca', message, observedAt: 1_000 })
      const join = vi.spyOn(Array.prototype, 'join')
      const evidence = drainClaudeChildWork(
        {
          childWork: new ClaudeChildWorkDecoder(),
          prompts: new ClaudePromptRegistry(),
          translator
        },
        message,
        1_000
      )
      let joinedOutputUnits = 0
      for (const parts of join.mock.contexts) {
        if (Array.isArray(parts) && (parts.includes(first) || parts.includes(second))) {
          for (const part of parts) {
            if (typeof part === 'string') {
              joinedOutputUnits += part.length
            }
          }
        }
      }
      vi.restoreAllMocks()

      expect(evidence).toEqual([
        { type: 'operation', observedAt: 1_000, childId: 'parent', operation: null }
      ])
      const result = items.find((item) => item.body.kind === 'tool-call')?.body
      if (result?.kind !== 'tool-call') {
        throw new Error('Result did not produce a journal tool-call body')
      }
      expect(result.output?.truncated).toBe(false)
      expect(result.output?.byteLength).toBe(first.length + second.length + 1)
      expect(result.output?.digest).toBe(
        createHash('sha256').update(first).update('\n').update(second).digest('hex')
      )
      expect(result.output?.head.length).toBe(first.length + second.length + 1)
      expect(result.output?.head.startsWith(first)).toBe(true)
      expect(result.output?.head.charAt(first.length)).toBe('\n')
      expect(result.output?.head.endsWith(second)).toBe(true)
      expect(joinedOutputUnits).toBe(0)
    } finally {
      vi.restoreAllMocks()
      translator.dispose()
    }
  })

  it('does not read child activity for a missing or invalid message envelope', () => {
    const activityOf = vi.fn(() => ({ agentId: 'child', openTool: null }))
    const message = frame([{ type: 'tool_result', tool_use_id: 'child' }], 'parent')

    expect(claudeChildOperation({}, activityOf, 1_000)).toEqual([])
    expect(claudeChildOperation({ ...message, type: 'system' }, activityOf, 1_000)).toEqual([])
    expect(claudeChildOperation({ ...message, uuid: '' }, activityOf, 1_000)).toEqual([])
    expect(activityOf).not.toHaveBeenCalled()
  })

  it('emits no child operation without an activity reader', () => {
    const message = frame([{ type: 'tool_result', tool_use_id: 'child' }], 'parent')

    expect(claudeChildOperation(message, undefined, 1_000)).toEqual([])
  })

  it('keeps canonical result admission and metadata ownership on explicit expected IDs', () => {
    const cases: { part: unknown; expectedId: string | null }[] = [
      { part: null, expectedId: null },
      { part: [], expectedId: null },
      { part: { type: 'tool_result' }, expectedId: null },
      { part: { type: 'tool_result', tool_use_id: '' }, expectedId: null },
      { part: { type: 'tool_result', tool_use_id: 4 }, expectedId: null },
      { part: { type: 'text', tool_use_id: 'child' }, expectedId: null },
      { part: { type: 'tool_result', tool_use_id: 'parent' }, expectedId: 'parent' },
      { part: { type: 'tool_result', tool_use_id: 'child' }, expectedId: 'child' },
      { part: { type: 'tool_result', tool_use_id: ' ' }, expectedId: ' ' },
      { part: { type: 'tool_result', tool_use_id: '\ud800' }, expectedId: '\ud800' }
    ]
    for (const { part, expectedId } of cases) {
      const message = frame([part], 'parent')
      const envelope = readClaudeMessageEnvelope(message)
      if (!envelope) {
        throw new Error('Fixture did not produce a provider envelope')
      }
      expect(claudeToolResults(envelope).map((result) => result.toolUseId)).toEqual(
        expectedId === null ? [] : [expectedId]
      )
      expect(
        claudeChildOperation(message, () => ({ agentId: 'child', openTool: null }), 1_000)
      ).toEqual(
        expectedId === null || expectedId === 'parent'
          ? []
          : [{ type: 'operation', observedAt: 1_000, childId: 'child', operation: null }]
      )
    }
  })
})
