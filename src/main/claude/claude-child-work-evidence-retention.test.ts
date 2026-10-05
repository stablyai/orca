import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { deriveToolInputPreview } from '../../shared/agent-hook-listener/tool-input-preview'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { claudeChildOperation, drainClaudeChildWork } from './claude-child-work-evidence'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import {
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'

function frame(content: unknown, parentToolUseId: string | null): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'result-frame',
    session_id: 'provider',
    parent_tool_use_id: parentToolUseId,
    message: { role: 'user', content }
  }
}

function previousChildOperation(
  message: Record<string, unknown>,
  activityOf: Parameters<typeof claudeChildOperation>[1],
  observedAt: number
): ReturnType<typeof claudeChildOperation> {
  const envelope = activityOf ? readClaudeMessageEnvelope(message) : null
  const parentRef = envelope?.parentToolUseId
  if (!envelope || !parentRef || !activityOf) {
    return []
  }
  const toolTraffic =
    claudeToolUses(envelope).length > 0 ||
    claudeToolResults(envelope).some((result) => result.toolUseId !== parentRef)
  if (!toolTraffic) {
    return []
  }
  const { agentId, openTool } = activityOf(parentRef)
  const input = openTool ? deriveToolInputPreview(openTool.name, openTool.input) : undefined
  return [
    {
      type: 'operation',
      observedAt,
      childId: agentId,
      operation: openTool
        ? { toolName: openTool.name, ...(input ? { input } : {}), basis: 'open', observedAt }
        : null
    }
  ]
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
      expect(result.output).toEqual({
        head: 'a'.repeat(16 * 1024),
        byteLength: first.length + second.length + 1,
        digest: createHash('sha256').update(first).update('\n').update(second).digest('hex'),
        truncated: true
      })
      expect(joinedOutputUnits).toBe(0)
    } finally {
      vi.restoreAllMocks()
      translator.dispose()
    }
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

  it('preserves operation ownership and traffic decisions for mixed provider envelopes', () => {
    const parts: unknown[] = [
      null,
      false,
      [],
      {},
      { type: 'tool_result' },
      { type: 'tool_result', tool_use_id: '' },
      { type: 'tool_result', tool_use_id: 4 },
      { type: 'tool_result', tool_use_id: 'parent' },
      { type: 'tool_result', tool_use_id: 'child' },
      { type: 'tool_result', tool_use_id: ' ' },
      { type: 'text', tool_use_id: 'child', text: 'message' },
      { type: 'tool_use', id: 'open', name: 'Bash', input: { command: 'pwd' } }
    ]
    const outputs = [undefined, null, '', 'text', 7, {}, ['a', 'b'], [{ type: 'text', text: '😀' }]]
    const activities: Parameters<typeof claudeChildOperation>[1][] = [
      undefined,
      () => ({ agentId: 'agent', openTool: null }),
      () => ({
        agentId: 'agent',
        openTool: { id: 'open', name: 'Bash', input: { command: 'pwd' } }
      })
    ]
    for (const part of parts) {
      for (const output of outputs) {
        const result =
          typeof part === 'object' && part !== null && !Array.isArray(part)
            ? { ...part, content: output }
            : part
        for (const parent of ['parent', 'child', '', ' ', null]) {
          for (const activity of activities) {
            const message = frame([result], parent)
            expect(claudeChildOperation(message, activity, 1_000)).toEqual(
              previousChildOperation(message, activity, 1_000)
            )
          }
        }
      }
    }
    const parentResult = { type: 'tool_result', tool_use_id: 'parent', content: 'spawned' }
    const childResult = { type: 'tool_result', tool_use_id: 'child', content: ['first', 'second'] }
    for (const content of [
      null,
      'text',
      [],
      parts,
      [parentResult, childResult],
      [childResult, parentResult],
      [{ type: 'tool_result', tool_use_id: '' }, parentResult, childResult]
    ]) {
      const message = frame(content, 'parent')
      expect(claudeChildOperation(message, activities[2], 1_000)).toEqual(
        previousChildOperation(message, activities[2], 1_000)
      )
      expect(claudeChildOperation({ ...message, type: 'system' }, activities[2], 1_000)).toEqual([])
    }
  })
})
