import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { activeStructuredAgentSessionTurnId } from '../../shared/structured-agent-session-projection'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
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
    ...(type === 'user' && parentToolUseId === null ? { startsTurn: true as const } : {}),
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      message: { role: type, content }
    }
  }
}

// Frames below follow the Claude Code 2.1.258 / SDK 0.3.251 partial-message
// cadence captured from the real CLI: every stream_event carries its own uuid,
// the final assistant frame for a block carries yet another, and only
// message.id ties them together.
function streamEvent(uuid: string, event: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      event
    }
  }
}

function resultFrame(subtype: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype,
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
      session_id: 'claude-session',
      uuid: `result-${subtype}`,
      ...fields
    }
  }
}

/** One streamed text turn in wire order: message_start, the block's start frame,
 *  one delta per chunk, the block's final assistant frame, the stop frames and
 *  the success result. */
function streamedTextTurn(input: {
  messageId: string
  startUuid: string
  finalUuid: string
  chunks: string[]
}) {
  const text = input.chunks.join('')
  return {
    start: [
      streamEvent(`${input.messageId}-message-start`, {
        type: 'message_start',
        message: { id: input.messageId, role: 'assistant', content: [] }
      }),
      streamEvent(input.startUuid, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    ],
    deltas: input.chunks.map((chunk, index) =>
      streamEvent(`${input.messageId}-delta-${index}`, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunk }
      })
    ),
    final: {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid: input.finalUuid,
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: {
          id: input.messageId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: null
        }
      }
    },
    stop: [
      streamEvent(`${input.messageId}-block-stop`, { type: 'content_block_stop', index: 0 }),
      streamEvent(`${input.messageId}-message-delta`, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' }
      }),
      streamEvent(`${input.messageId}-message-stop`, { type: 'message_stop' }),
      resultFrame('success', {
        is_error: false,
        result: text,
        stop_reason: 'end_turn',
        terminal_reason: 'completed'
      })
    ],
    text
  }
}

function assistantMessages<T extends { body: AgentJournalItemBody }>(items: T[]): T[] {
  return items.filter((item) => item.body.kind === 'message' && item.body.role === 'assistant')
}

function providerFrameKinds(items: { body: AgentJournalItemBody }[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame.kind] : []
  )
}

const JOURNAL_IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: 'leaf-1' }
}

let journalRoot = ''

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-claude-journal-translation-'))
})

afterEach(async () => {
  await rm(journalRoot, { recursive: true, force: true })
})

describe('Claude structured journal translation', () => {
  it('coalesces partial deltas onto the block identity and reconciles the final frame onto it', () => {
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
    const turn = streamedTextTurn({
      messageId: 'msg_01',
      startUuid: 'block-start-1',
      finalUuid: 'assistant-final-1',
      chunks: ['ST', 'REAMOK_ELEC_64E632']
    })
    const streamedIdentity = {
      provider: 'claude',
      sessionId: 'claude-session',
      uuid: 'block-start-1'
    }

    for (const event of turn.start) {
      translator.handle(event)
    }
    for (const delta of turn.deltas) {
      translator.handle(delta)
    }
    expect(state.items).toEqual([])

    const run = scheduled as (() => void) | null
    run?.()
    expect(state.items.at(-1)).toEqual({
      identity: streamedIdentity,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: turn.text }] }
    })

    translator.handle(turn.final)
    for (const event of turn.stop) {
      translator.handle(event)
    }
    const assistant = assistantMessages(state.items)
    expect(assistant.at(-1)).toEqual({
      identity: streamedIdentity,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: turn.text }] }
    })
    expect(new Set(assistant.map((item) => agentJournalItemKey(item.identity))).size).toBe(1)
    expect(providerFrameKinds(state.items)).toEqual([])
  })

  it('journals a count-to-200 stream as one assistant item carrying the complete reply', async () => {
    const journal = await openAgentSessionJournal({
      identity: JOURNAL_IDENTITY,
      journalDir: journalRoot,
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind({ journal, fence: 1, publish: vi.fn() })
    let scheduled: (() => void) | null = null
    const translator = createClaudeJournalTranslator({
      sink: deferred.sink,
      schedule: (run) => {
        scheduled = run
        return () => {
          scheduled = null
        }
      }
    })
    const numbers = Array.from({ length: 200 }, (_, index) => String(index + 1))
    // The chunk boundaries the real CLI produced for this prompt.
    const boundaries = [0, 1, 45, 93, 141, 189, 200]
    const chunks = boundaries.slice(1).map((end, index) => {
      const slice = numbers.slice(boundaries[index], end).join('\n')
      return index === 0 ? slice : `\n${slice}`
    })
    const turn = streamedTextTurn({
      messageId: 'msg_count',
      startUuid: 'count-start',
      finalUuid: 'count-final',
      chunks
    })

    for (const event of turn.start) {
      translator.handle(event)
    }
    for (const delta of turn.deltas) {
      translator.handle(delta)
      // Each chunk lands in its own coalescing window, as it did on the wire.
      const run = scheduled as (() => void) | null
      run?.()
    }
    translator.handle(turn.final)
    for (const event of turn.stop) {
      translator.handle(event)
    }
    await deferred.drained()

    const items: AgentJournalRenderItem[] = journal.snapshot().items
    const assistant = assistantMessages(items)
    expect(assistant.map((item) => item.itemId)).toEqual(['claude:claude-session:count-start'])
    expect(assistant[0]?.body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: numbers.join('\n') }]
    })
    expect(providerFrameKinds(items)).toEqual([])
  })

  it('settles result frames, empty thinking and string user replays without painting a row', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      startsTurn: true,
      message: {
        type: 'user',
        uuid: 'user-replay-1',
        session_id: 'claude-session',
        parent_tool_use_id: null,
        isReplay: true,
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { role: 'user', content: 'Reply with exactly PROBE_OK_1 and nothing else.' }
      }
    })
    translator.handle(
      message('assistant', 'assistant-thinking-empty', [
        { type: 'thinking', thinking: '', signature: 'CAQS6QcKEAgRGAI4AUIIdGhpbmtpbmc' }
      ])
    )
    translator.handle(
      resultFrame('success', {
        is_error: false,
        result: 'PROBE_OK_1',
        stop_reason: 'end_turn',
        terminal_reason: 'completed'
      })
    )
    translator.handle(
      message('user', 'user-interrupt', [{ type: 'text', text: '[Request interrupted by user]' }])
    )
    translator.handle(
      resultFrame('error_during_execution', {
        is_error: true,
        errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
        stop_reason: null,
        terminal_reason: 'aborted_streaming',
        permission_denials: []
      })
    )
    translator.handle(message('user', 'control-only', []))

    expect(providerFrameKinds(state.items)).toEqual([])
    expect(
      state.items.flatMap((item) =>
        item.body.kind === 'message' && item.body.role === 'user' ? [item.body.blocks] : []
      )
    ).toEqual([
      [{ type: 'text', text: 'Reply with exactly PROBE_OK_1 and nothing else.' }],
      [{ type: 'text', text: '[Request interrupted by user]' }]
    ])
    expect(
      state.items.some((item) => item.body.kind === 'status' && !item.body.turnLifecycle)
    ).toBe(false)
    expect(
      state.tombstones.flatMap((identity) =>
        identity.provider === 'legacy' ? [identity.recordId] : []
      )
    ).toEqual(['turn-lifecycle:user-replay-1', 'turn-lifecycle:user-interrupt'])
  })

  it('does not reopen a completed turn when the SDK replays its user row after restart', () => {
    const live = sinkState()
    const liveTranslator = createClaudeJournalTranslator({ sink: live.sink })
    const replay = {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'user',
        uuid: 'picker-command-1',
        session_id: 'claude-session',
        parent_tool_use_id: null,
        isReplay: true,
        message: { role: 'user', content: '/model' }
      }
    }

    liveTranslator.handle({ ...replay, startsTurn: true })
    liveTranslator.handle(resultFrame('success', { is_error: false, result: '' }))
    expect(live.tombstones).toContainEqual({
      provider: 'legacy',
      agent: 'claude',
      sessionId: 'claude-session',
      recordId: 'turn-lifecycle:picker-command-1'
    })
    liveTranslator.dispose()

    const restarted = sinkState()
    const restartedTranslator = createClaudeJournalTranslator({ sink: restarted.sink })
    restartedTranslator.handle(replay)

    expect(
      activeStructuredAgentSessionTurnId(
        restarted.items.map((item, sequence) => ({
          itemId: agentJournalItemKey(item.identity),
          revision: 1,
          body: item.body,
          sequence,
          observedAt: sequence
        }))
      )
    ).toBeNull()
  })

  it('surfaces an API error carried by a success-subtype result with no assistant frame', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(message('user', 'user-1', [{ type: 'text', text: 'summarize this' }]))
    // The SDK models this as a SUCCESS-subtype result whose `result` string is the
    // user-facing API error. Suppressing it as ordinary turn bookkeeping ends the
    // turn with nothing shown at all.
    translator.handle(
      resultFrame('success', {
        is_error: true,
        result: 'API Error: 529 upstream overloaded',
        stop_reason: null,
        terminal_reason: 'api_error'
      })
    )

    expect(providerFrameKinds(state.items)).toEqual(['message:result:success'])
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'status',
      text: 'API Error: 529 upstream overloaded'
    })
    // The turn still settles: the error is an extra row, not a stuck lifecycle.
    expect(
      state.tombstones.flatMap((identity) =>
        identity.provider === 'legacy' ? [identity.recordId] : []
      )
    ).toEqual(['turn-lifecycle:user-1'])
  })

  it('drops the stream state of turns that ended without their final frame', () => {
    const state = sinkState()
    let scheduled: (() => void) | null = null
    const translator = createClaudeJournalTranslator({
      sink: state.sink,
      schedule: (run) => {
        scheduled = run
        return () => {
          scheduled = null
        }
      }
    })
    for (let turn = 0; turn < 3; turn += 1) {
      const aborted = streamedTextTurn({
        messageId: `msg_abort_${turn}`,
        startUuid: `abort-start-${turn}`,
        finalUuid: `abort-final-${turn}`,
        chunks: ['x'.repeat(4_000)]
      })
      for (const event of [...aborted.start, ...aborted.deltas]) {
        translator.handle(event)
      }
      const run = scheduled as (() => void) | null
      run?.()
      // The user interrupts: the result arrives with no final assistant frame,
      // so nothing ever reconciles these blocks.
      translator.handle(
        resultFrame('error_during_execution', {
          is_error: true,
          terminal_reason: 'aborted_streaming'
        })
      )
      // The partial text is already journaled; only the live state is dropped.
      expect(translator.pendingStreamedBlocks).toBe(0)
    }

    expect(assistantMessages(state.items)).toHaveLength(3)
  })

  it('keeps an ordinary successful result off the timeline', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(resultFrame('success', { is_error: false, result: 'done', errors: [] }))

    expect(providerFrameKinds(state.items)).toEqual([])
  })

  it('surfaces the reason an error-subtype result stopped the turn', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      resultFrame('error_max_turns', { is_error: true, errors: ['turn limit reached'] })
    )

    expect(providerFrameKinds(state.items)).toEqual(['message:result:error_max_turns'])
  })

  it('keeps an unmodeled result subtype on the bounded provider fallback', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      resultFrame('error_from_the_future', { is_error: true, errors: ['budget exhausted'] })
    )

    expect(providerFrameKinds(state.items)).toEqual(['message:result:error_from_the_future'])
  })

  it('journals turn lifecycle and updates one tool row through its result', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

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

    translator.handle(
      message(
        'user',
        'tool-result-2',
        [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done again' }],
        'tool-1'
      )
    )
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'tool-call',
      name: 'tool',
      input: null,
      output: { head: 'done again' }
    })

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'result', session_id: 'claude-session', uuid: 'result-1' }
    })
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

  it('starts a cancellable lifecycle for image-only root user replays', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      message('user', 'user-image', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
      ])
    )

    expect(state.items.at(-1)?.body).toEqual({
      kind: 'status',
      text: 'Claude is working…',
      turnLifecycle: { turnId: 'user-image', state: 'running' }
    })
  })

  it('does not start a lifecycle for a top-level user tool result', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      message('user', 'tool-result-only', [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }
      ])
    )

    expect(state.items.map((item) => agentJournalItemKey(item.identity))).toEqual([
      'orca:claude-tool%3Aclaude-session%3Atool-1'
    ])
    expect(state.items[0]?.body).toMatchObject({
      kind: 'tool-call',
      state: 'completed',
      output: { head: 'done' }
    })
    expect(
      state.items.some(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle !== undefined
      )
    ).toBe(false)
  })

  it('paints nothing for a user frame that carries no content', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(message('user', 'control-only', []))

    expect(state.items).toEqual([])
    expect(state.tombstones).toEqual([])
  })

  it('renders unmodeled substantive Claude frames as bounded provider rows', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'system', subtype: 'local_command_output', summary: 'x'.repeat(100_000) }
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
        'message:system:local_command_output',
        'message:system:command_started',
        'message:result',
        'message:user:content:document',
        'control_request:future_control'
      ])
    )
    expect(frames.map((frame) => frame.kind)).not.toEqual(
      expect.arrayContaining([
        'message:system:hook_response',
        'message:tool_progress',
        'message:prompt_suggestion'
      ])
    )
    expect(
      frames.find((frame) => frame.kind === 'message:system:local_command_output')?.payload
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
    settle: () => {}
  }
}
