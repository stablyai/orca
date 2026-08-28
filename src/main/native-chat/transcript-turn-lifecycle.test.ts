import { describe, expect, it } from 'vitest'
import {
  decodeClaudeTurnLifecycle,
  decodeCodexTurnLifecycle,
  decodeKimiTurnLifecycle,
  nativeChatTurnLifecycleDecoderForAgent
} from './transcript-turn-lifecycle'

describe('kimi turn lifecycle', () => {
  const kimiPrompt = (kind: string, time = 1787558233174): string =>
    JSON.stringify({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'go' }],
      origin: { kind },
      time
    })
  const kimiStepEnd = (finishReason: string, time = 1787558240372): string =>
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: 's-1', turnId: '0', step: 1, finishReason },
      time
    })

  it('starts working on a user prompt and completes on an end_turn step', () => {
    expect(decodeKimiTurnLifecycle(kimiPrompt('user'), 'fallback')).toEqual({
      state: 'working',
      turnId: 'fallback',
      timestamp: 1787558233174
    })
    expect(decodeKimiTurnLifecycle(kimiStepEnd('end_turn'), 'fallback')).toEqual({
      state: 'completed',
      turnId: '0',
      timestamp: 1787558240372
    })
  })

  it('starts working on a user steer but ignores automation steers', () => {
    const kimiSteer = (kind: string, time = 1787558235000): string =>
      JSON.stringify({
        type: 'turn.steer',
        input: [{ type: 'text', text: 'actually, do this instead' }],
        origin: { kind },
        time
      })
    expect(decodeKimiTurnLifecycle(kimiSteer('user'), 'fallback')).toEqual({
      state: 'working',
      turnId: 'fallback',
      timestamp: 1787558235000
    })
    expect(decodeKimiTurnLifecycle(kimiSteer('background_task'), 'fallback')).toBeNull()
    expect(decodeKimiTurnLifecycle(kimiSteer('cron_job'), 'fallback')).toBeNull()
  })

  it('ignores automation prompts and mid-turn tool_use steps', () => {
    expect(decodeKimiTurnLifecycle(kimiPrompt('background_task'), 'fallback')).toBeNull()
    expect(decodeKimiTurnLifecycle(kimiPrompt('cron_job'), 'fallback')).toBeNull()
    expect(decodeKimiTurnLifecycle(kimiPrompt('system_trigger'), 'fallback')).toBeNull()
    expect(decodeKimiTurnLifecycle(kimiStepEnd('tool_use'), 'fallback')).toBeNull()
    expect(
      decodeKimiTurnLifecycle(
        JSON.stringify({
          type: 'context.append_loop_event',
          event: { type: 'step.begin', uuid: 's-1', turnId: '0', step: 1 },
          time: 1
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('marks turn.cancel interrupted and skips unrelated records', () => {
    expect(
      decodeKimiTurnLifecycle(JSON.stringify({ type: 'turn.cancel', time: 1787601518211 }), 'fb')
    ).toEqual({ state: 'interrupted', turnId: 'fb', timestamp: 1787601518211 })
    expect(
      decodeKimiTurnLifecycle(
        JSON.stringify({
          type: 'turn.cancel',
          target: 'active',
          reason: 'user_cancelled',
          time: 1787601518212
        }),
        'fb'
      )
    ).toEqual({ state: 'interrupted', turnId: 'fb', timestamp: 1787601518212 })
    expect(
      decodeKimiTurnLifecycle(JSON.stringify({ type: 'usage.record', time: 1 }), 'fb')
    ).toBeNull()
    expect(decodeKimiTurnLifecycle('not json', 'fb')).toBeNull()
  })

  it('ignores a queued-prompt cancel: nothing was interrupted', () => {
    expect(
      decodeKimiTurnLifecycle(
        JSON.stringify({
          type: 'turn.cancel',
          target: 'queued',
          reason: 'user_cancelled',
          time: 1
        }),
        'fb'
      )
    ).toBeNull()
  })
})

describe('native chat transcript turn lifecycle', () => {
  it('exposes a lifecycle decoder only for transcript formats with explicit boundaries', () => {
    expect(nativeChatTurnLifecycleDecoderForAgent('claude')).not.toBeNull()
    expect(nativeChatTurnLifecycleDecoderForAgent('openclaude')).not.toBeNull()
    expect(nativeChatTurnLifecycleDecoderForAgent('codex')).not.toBeNull()
    expect(nativeChatTurnLifecycleDecoderForAgent('grok')).toBeNull()
    expect(nativeChatTurnLifecycleDecoderForAgent('kimi')).not.toBeNull()
  })

  it('decodes Codex task boundaries with the provider turn id', () => {
    expect(
      decodeCodexTurnLifecycle(
        JSON.stringify({
          timestamp: '2026-07-16T23:40:14.001Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-1' }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'working',
      turnId: 'turn-1',
      timestamp: Date.parse('2026-07-16T23:40:14.001Z')
    })

    expect(
      decodeCodexTurnLifecycle(
        JSON.stringify({
          timestamp: '2026-07-16T23:45:37.608Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'turn-1' }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'completed',
      turnId: 'turn-1',
      timestamp: Date.parse('2026-07-16T23:45:37.608Z')
    })

    expect(
      decodeCodexTurnLifecycle(
        JSON.stringify({
          timestamp: '2026-07-16T23:46:01.000Z',
          type: 'event_msg',
          payload: { type: 'turn_aborted', reason: 'interrupted', turn_id: 'turn-2' }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'interrupted',
      turnId: 'turn-2',
      timestamp: Date.parse('2026-07-16T23:46:01.000Z')
    })
  })

  it('does not mistake a Codex assistant message for completion', () => {
    expect(
      decodeCodexTurnLifecycle(
        JSON.stringify({
          timestamp: '2026-07-16T23:45:37.472Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'final-looking prose' }
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('uses Claude terminal stop_reasons and excludes tool-result user rows', () => {
    for (const stopReason of ['end_turn', 'max_tokens', 'stop_sequence', 'refusal'] as const) {
      expect(
        decodeClaudeTurnLifecycle(
          JSON.stringify({
            type: 'assistant',
            uuid: `assistant-${stopReason}`,
            timestamp: '2026-07-16T23:45:37.608Z',
            message: { role: 'assistant', stop_reason: stopReason, content: [] }
          }),
          'fallback'
        )
      ).toEqual({
        state: 'completed',
        turnId: `assistant-${stopReason}`,
        timestamp: Date.parse('2026-07-16T23:45:37.608Z')
      })
    }

    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'tool-result-1',
          timestamp: '2026-07-16T23:45:38.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }]
          }
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('does not treat Claude mid-turn tool_use assistant rows as completed', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-tool',
          timestamp: '2026-07-16T23:45:37.608Z',
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]
          }
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('treats Claude assistant rows with omitted stop_reason and content as completed', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-null-stop',
          timestamp: '2026-07-16T23:45:37.608Z',
          message: {
            role: 'assistant',
            stop_reason: null,
            content: [{ type: 'text', text: 'final answer' }]
          }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'completed',
      turnId: 'assistant-null-stop',
      timestamp: Date.parse('2026-07-16T23:45:37.608Z')
    })

    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-missing-stop',
          timestamp: '2026-07-16T23:45:37.608Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'final answer' }]
          }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'completed',
      turnId: 'assistant-missing-stop',
      timestamp: Date.parse('2026-07-16T23:45:37.608Z')
    })
  })

  it('does not complete a Claude assistant row that omits stop_reason but carries a tool_use block', () => {
    // A pre-tool row can hold prose AND a tool_use block; without stop_reason the
    // turn is still mid-flight, so it must not settle the spinner before the tool.
    for (const stopReason of [null, undefined] as const) {
      expect(
        decodeClaudeTurnLifecycle(
          JSON.stringify({
            type: 'assistant',
            uuid: `assistant-pretool-${stopReason}`,
            timestamp: '2026-07-16T23:45:37.608Z',
            message: {
              role: 'assistant',
              ...(stopReason === null ? { stop_reason: null } : {}),
              content: [
                { type: 'text', text: 'let me check' },
                { type: 'tool_use', id: 't1', name: 'Bash', input: {} }
              ]
            }
          }),
          'fallback'
        )
      ).toBeNull()
    }
  })

  it('does not complete Claude assistant rows with omitted stop_reason and no content', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-empty',
          timestamp: '2026-07-16T23:45:37.608Z',
          message: { role: 'assistant', stop_reason: null, content: [] }
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('does not treat harness noise user rows as a new working generation', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'task-note-1',
          timestamp: '2026-07-16T23:46:10.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<task-notification>background task finished</task-notification>'
              }
            ]
          }
        }),
        'fallback'
      )
    ).toBeNull()

    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'reminder-1',
          timestamp: '2026-07-16T23:46:11.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<system-reminder>continue</system-reminder>' }]
          }
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('excludes Claude tool-result rows that also carry text sidecars', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'mixed-tool-result',
          timestamp: '2026-07-16T23:45:38.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
              { type: 'text', text: '<system-reminder>continue</system-reminder>' }
            ]
          }
        }),
        'fallback'
      )
    ).toBeNull()
  })

  it('treats a real Claude user row as the next working generation', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'user-2',
          timestamp: '2026-07-16T23:46:00.000Z',
          message: { role: 'user', content: 'next task' }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'working',
      turnId: 'user-2',
      timestamp: Date.parse('2026-07-16T23:46:00.000Z')
    })
  })

  it('treats Claude interruptedMessageId as terminal instead of a user generation', () => {
    expect(
      decodeClaudeTurnLifecycle(
        JSON.stringify({
          type: 'user',
          uuid: 'interrupt-row',
          interruptedMessageId: 'assistant-request-1',
          timestamp: '2026-07-16T23:46:01.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }]
          }
        }),
        'fallback'
      )
    ).toEqual({
      state: 'interrupted',
      turnId: 'assistant-request-1',
      timestamp: Date.parse('2026-07-16T23:46:01.000Z')
    })
  })
})
