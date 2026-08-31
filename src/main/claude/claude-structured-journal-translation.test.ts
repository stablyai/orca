import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ClaudePendingPrompt } from './claude-structured-prompt-replies'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn()
  }
  return { sink, items, tombstones }
}

function message(
  type: 'assistant' | 'user',
  uuid: string,
  content: unknown[],
  parentToolUseId: string | null = null
) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      message: { role: type, content }
    }
  }
}

describe('Claude structured journal translation', () => {
  it('reuses the shared coalescer and finalizes the provider-keyed message row', () => {
    const state = sinkState()
    let scheduled: (() => void) | null = null
    const translator = createClaudeJournalTranslator({
      sink: state.sink,
      schedule: (run, delay) => {
        expect(delay).toBe(60)
        scheduled = run
        return () => {
          scheduled = null
        }
      }
    })

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        uuid: 'assistant-1',
        session_id: 'claude-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
      }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        uuid: 'assistant-1',
        session_id: 'claude-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }
      }
    })
    expect(state.items).toEqual([])

    const run = scheduled as (() => void) | null
    run?.()
    expect(state.items.at(-1)).toEqual({
      identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'assistant-1' },
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }] }
    })

    translator.handle(message('assistant', 'assistant-1', [{ type: 'text', text: 'Hello!' }]))
    expect(state.items.at(-1)).toEqual({
      identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'assistant-1' },
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello!' }] }
    })
  })

  it('journals turn lifecycle and updates one tool row through its result', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.registerOwnedTurn('claude-session', 'user-1', 0)
    translator.confirmOwnedTurn('user-1')
    translator.handle(message('user', 'user-1', [{ type: 'text', text: 'List files' }]))
    translator.handle(
      message('assistant', 'assistant-tool', [
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }
      ])
    )
    translator.handle(
      message(
        'user',
        'tool-result-1',
        [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'a.ts\nb.ts' }],
        'tool-1'
      )
    )

    const keyed = new Map(
      state.items.map((item) => [agentJournalItemKey(item.identity), item.body])
    )
    expect(keyed.get('claude:claude-session:user-1')).toMatchObject({
      kind: 'message',
      role: 'user'
    })
    expect(keyed.get('orca:claude-tool%3Aclaude-session%3Atool-1')).toMatchObject({
      kind: 'tool-call',
      name: 'Bash',
      state: 'completed',
      output: { head: 'a.ts\nb.ts', truncated: false }
    })
    expect(
      state.items.some(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.turnId === 'user-1'
      )
    ).toBe(true)

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'result',
        session_id: 'claude-session',
        uuid: 'result-1',
        user_message_uuid: 'user-1'
      }
    })
    translator.settleOwnedTurn('user-1')
    expect(state.tombstones.at(-1)).toMatchObject({
      provider: 'legacy',
      agent: 'claude',
      recordId: 'turn-lifecycle:user-1'
    })
  })

  it('bounds persisted thinking text to the shared journal payload limit', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const thinking = 'considering '.repeat(20_000)

    translator.handle(message('assistant', 'assistant-thinking', [{ type: 'thinking', thinking }]))

    expect(state.items.at(-1)?.body).toEqual({
      kind: 'status',
      text: boundInlineText(thinking, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    })
  })

  it('starts a cancellable lifecycle for an owned image-only send', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.registerOwnedTurn('claude-session', 'user-image', 0)
    translator.confirmOwnedTurn('user-image')

    expect(state.items.at(-1)?.body).toEqual({
      kind: 'status',
      text: 'Claude is working…',
      turnLifecycle: { turnId: 'user-image', state: 'running' }
    })
  })

  it('settles only the named owned turn and ignores repeated settled echoes', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.registerOwnedTurn('claude-session', 'turn-a', 0)
    translator.confirmOwnedTurn('turn-a')
    translator.registerOwnedTurn('claude-session', 'turn-b', 1)
    translator.confirmOwnedTurn('turn-b')
    translator.handle(
      message(
        'user',
        'tool-result',
        [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        null
      )
    )
    translator.handle(message('user', 'injected', [{ type: 'text', text: '<local-command>' }]))
    translator.confirmOwnedTurn('turn-b')

    translator.settleOwnedTurn('turn-b')
    expect(
      state.tombstones.map((identity) =>
        identity.provider === 'legacy' ? identity.recordId : undefined
      )
    ).toEqual(['turn-lifecycle:turn-b'])
    expect(
      state.items.filter(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.turnId === 'turn-a'
      )
    ).toHaveLength(1)
    translator.confirmOwnedTurn('turn-b')
    expect(
      state.items.filter(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.turnId === 'turn-b'
      )
    ).toHaveLength(1)

    translator.settleOwnedTurn('turn-a')
    expect(state.tombstones.at(-1)).toMatchObject({ recordId: 'turn-lifecycle:turn-a' })
    translator.confirmOwnedTurn('turn-a')
    expect(
      state.items.filter(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.turnId === 'turn-a'
      )
    ).toHaveLength(1)

    translator.registerOwnedTurn('claude-session', 'turn-c', 2)
    translator.confirmOwnedTurn('turn-c')
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })
    translator.registerOwnedTurn('claude-session', 'turn-after-exit', 3)
    translator.confirmOwnedTurn('turn-after-exit')
    translator.settleOwnedTurn('turn-after-exit')
    expect(
      state.tombstones.map((identity) =>
        identity.provider === 'legacy' ? identity.recordId : undefined
      )
    ).toEqual(['turn-lifecycle:turn-b', 'turn-lifecycle:turn-a', 'turn-lifecycle:turn-c'])
    expect(
      state.items.some(
        (item) =>
          item.body.kind === 'status' && item.body.turnLifecycle?.turnId === 'turn-after-exit'
      )
    ).toBe(false)
  })

  it('does not let results beat provisional or abandoned turn slots', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.registerOwnedTurn('claude-session', 'before-write-resolves', 0)
    translator.settleOwnedTurn('before-write-resolves')
    translator.confirmOwnedTurn('before-write-resolves')

    translator.registerOwnedTurn('claude-session', 'failed-write', 1)
    translator.abandonOwnedTurn('failed-write')
    translator.settleOwnedTurn('failed-write')
    translator.confirmOwnedTurn('failed-write')

    expect(
      state.items.filter(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle !== undefined
      )
    ).toEqual([])
  })

  it('renders empty user frames through the provider fallback', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(message('user', 'control-only', []))

    expect(state.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            kind: 'status',
            providerFrame: expect.objectContaining({ kind: 'message:user:empty' })
          })
        })
      ])
    )
  })

  it('renders every unmodeled Claude frame family as a bounded provider row', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'system', subtype: 'compact_boundary', summary: 'x'.repeat(100_000) }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'system', subtype: 'hook_response', hook_name: 'PostToolUse' }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'system', subtype: 'command_started', command: '/compact' }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'result', usage: { input_tokens: 12 }, total_cost_usd: 0.01 }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'tool_progress', tool_use_id: 'tool-1', elapsed_time_seconds: 2 }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'prompt_suggestion', suggestion: '/compact' }
    })
    translator.handle(
      message('user', 'attachment-1', [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf' } }
      ])
    )
    translator.handle({
      type: 'provider-frame',
      sessionId: 'orca-session',
      kind: 'control_request:future_control',
      payload: { subtype: 'future_control' }
    })

    const frames = state.items.flatMap((item) =>
      item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame] : []
    )
    expect(frames.map((frame) => frame.kind)).toEqual(
      expect.arrayContaining([
        'message:system:compact_boundary',
        'message:system:hook_response',
        'message:system:command_started',
        'message:result',
        'message:tool_progress',
        'message:prompt_suggestion',
        'message:user:content:document',
        'control_request:future_control'
      ])
    )
    expect(
      frames.find((frame) => frame.kind === 'message:system:compact_boundary')?.payload
    ).toEqual(expect.objectContaining({ truncated: true, byteLength: expect.any(Number) }))
  })

  it('preserves a question group as one addressable prompt and cancels it durably', () => {
    const state = sinkState()
    const bindings: unknown[][] = []
    const translator = createClaudeJournalTranslator({
      sink: state.sink,
      bindPromptItemId: (...args) => bindings.push(args)
    })
    const approval = prompt({
      requestId: 'permission-1',
      promptKey: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      kind: 'approval',
      input: { command: 'git status' },
      questionIds: []
    })
    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt: approval })
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'approval',
      title: 'Allow Bash?',
      options: expect.arrayContaining([{ id: 'allow', label: 'Allow' }])
    })
    expect(bindings[0]).toEqual([
      'orca:claude-prompt%3Aorca-session%3Apermission-1',
      'permission-1'
    ])

    const questions = prompt({
      requestId: 'questions-1',
      promptKey: 'questions-1',
      toolUseId: 'tool-q',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: {
        questions: [
          { question: 'Library?', options: [{ label: 'Luxon' }] },
          { question: 'Ship?', options: [{ label: 'Yes' }] }
        ]
      },
      questionIds: ['Library?', 'Ship?']
    })
    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt: questions })
    expect(state.items.filter((item) => item.body.kind === 'question')).toHaveLength(1)
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'question',
      questions: [
        { id: 'q1', question: 'Library?', multiSelect: false },
        { id: 'q2', question: 'Ship?', multiSelect: false }
      ]
    })
    expect(bindings.at(-1)).toEqual([
      'orca:claude-prompt%3Aorca-session%3Aquestions-1',
      'questions-1'
    ])

    const multiSelect = prompt({
      requestId: 'questions-multi',
      promptKey: 'questions-multi',
      toolUseId: 'tool-multi',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: {
        questions: [
          {
            question: 'Libraries?',
            multiSelect: true,
            options: [{ label: 'Luxon' }, { label: 'Temporal' }]
          }
        ]
      },
      questionIds: ['Libraries?']
    })
    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt: multiSelect })
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'question',
      question: '1 grouped question from Claude',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Libraries?',
          multiSelect: true,
          options: [{ label: 'Luxon' }, { label: 'Temporal' }],
          freeTextQuestionId: 'q1'
        }
      ]
    })

    translator.handle({
      type: 'prompt-cancelled',
      sessionId: 'orca-session',
      promptKey: 'questions-1'
    })
    expect(state.tombstones).toHaveLength(1)
  })
})

function prompt(
  input: Pick<
    ClaudePendingPrompt,
    'requestId' | 'promptKey' | 'toolUseId' | 'toolName' | 'kind' | 'input' | 'questionIds'
  >
): ClaudePendingPrompt {
  return {
    ...input,
    suggestions: [],
    answers: new Map(),
    request: { subtype: 'can_use_tool' }
  }
}
