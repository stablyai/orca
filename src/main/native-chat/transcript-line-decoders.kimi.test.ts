import { describe, expect, it } from 'vitest'
import { decodeKimiTranscriptLine } from './transcript-line-decoders'

const line = (record: unknown): string => JSON.stringify(record)

const loopEvent = (event: Record<string, unknown>): string =>
  line({ type: 'context.append_loop_event', event, time: 1787558237519 })

const userTurn = (kind: string, recordType = 'turn.prompt'): string =>
  line({
    type: recordType,
    input: [{ type: 'text', text: 'resume the sweep' }],
    origin: { kind },
    time: 1787558233174
  })

describe('decodeKimiTranscriptLine', () => {
  it('skips malformed lines and session bookkeeping records', () => {
    expect(decodeKimiTranscriptLine('not json', 'f')).toBeNull()
    expect(
      decodeKimiTranscriptLine(line({ type: 'metadata', protocol_version: '1.4' }), 'f')
    ).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'llm.request' }), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'usage.record' }), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'config.update' }), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'tools.update_store' }), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'permission.set_mode' }), 'f')).toBeNull()
    expect(
      decodeKimiTranscriptLine(line({ type: 'permission.record_approval_result' }), 'f')
    ).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'plan_mode.enter' }), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(line({ type: 'a-type-from-the-future' }), 'f')).toBeNull()
  })

  it('skips step boundary events; the lifecycle decoder owns those', () => {
    expect(
      decodeKimiTranscriptLine(
        loopEvent({ type: 'step.begin', uuid: 's-1', turnId: '0', step: 1 }),
        'f'
      )
    ).toBeNull()
    expect(
      decodeKimiTranscriptLine(
        loopEvent({
          type: 'step.end',
          uuid: 's-1',
          turnId: '0',
          step: 1,
          finishReason: 'end_turn'
        }),
        'f'
      )
    ).toBeNull()
  })

  it('skips context.append_message: it duplicates turn.prompt and carries injections', () => {
    const append = (kind: string): string =>
      line({
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }], origin: { kind } },
        time: 1
      })
    expect(decodeKimiTranscriptLine(append('user'), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(append('injection'), 'f')).toBeNull()
    expect(decodeKimiTranscriptLine(append('background_task'), 'f')).toBeNull()
  })

  it('decodes a user turn.prompt', () => {
    expect(decodeKimiTranscriptLine(userTurn('user'), 'fb')).toEqual({
      id: 'fb',
      role: 'user',
      blocks: [{ type: 'text', text: 'resume the sweep' }],
      timestamp: 1787558233174,
      source: 'transcript'
    })
  })

  it('decodes a mid-turn user steer but drops automation steers', () => {
    expect(decodeKimiTranscriptLine(userTurn('user', 'turn.steer'), 'fb')?.role).toBe('user')
    expect(decodeKimiTranscriptLine(userTurn('background_task', 'turn.steer'), 'fb')).toBeNull()
    expect(decodeKimiTranscriptLine(userTurn('cron_job', 'turn.steer'), 'fb')).toBeNull()
    expect(decodeKimiTranscriptLine(userTurn('system_trigger', 'turn.prompt'), 'fb')).toBeNull()
    expect(decodeKimiTranscriptLine(userTurn('injection', 'turn.prompt'), 'fb')).toBeNull()
  })

  it('keeps every text part of a multi-part prompt and drops empty/unknown parts', () => {
    const decoded = decodeKimiTranscriptLine(
      line({
        type: 'turn.prompt',
        input: [
          { type: 'text', text: 'first' },
          { type: 'text', text: '  ' },
          { type: 'image', path: '/tmp/x.png' },
          { type: 'text', text: 'second' }
        ],
        origin: { kind: 'user' },
        time: 5
      }),
      'fb'
    )
    expect(decoded?.blocks).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ])
  })

  it('returns null for a user turn with no renderable text', () => {
    expect(
      decodeKimiTranscriptLine(
        line({ type: 'turn.prompt', input: [], origin: { kind: 'user' }, time: 5 }),
        'fb'
      )
    ).toBeNull()
  })

  it('decodes a complete assistant text part with its own uuid and turnId', () => {
    expect(
      decodeKimiTranscriptLine(
        loopEvent({
          type: 'content.part',
          uuid: 'p-1',
          turnId: '0',
          step: 1,
          stepUuid: 's-1',
          part: { type: 'text', text: 'Reading it now.' }
        }),
        'fb'
      )
    ).toEqual({
      id: 'p-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Reading it now.' }],
      timestamp: 1787558237519,
      source: 'transcript',
      turnId: '0'
    })
  })

  it('renders a think part as assistant text, mirroring omp thinking', () => {
    const decoded = decodeKimiTranscriptLine(
      loopEvent({
        type: 'content.part',
        uuid: 'p-2',
        turnId: '1',
        step: 3,
        part: { type: 'think', think: 'Weighing two options' }
      }),
      'fb'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Weighing two options' }])
  })

  it('drops empty parts and unknown part types', () => {
    const part = (p: unknown): string =>
      loopEvent({ type: 'content.part', uuid: 'p-3', turnId: '0', step: 1, part: p })
    expect(decodeKimiTranscriptLine(part({ type: 'text', text: '   ' }), 'fb')).toBeNull()
    expect(decodeKimiTranscriptLine(part({ type: 'think', think: '' }), 'fb')).toBeNull()
    expect(decodeKimiTranscriptLine(part({ type: 'image', blob: 'sha256:xx' }), 'fb')).toBeNull()
    expect(decodeKimiTranscriptLine(part(null), 'fb')).toBeNull()
  })

  it('decodes a tool call with its args, keyed by toolCallId + line anchor', () => {
    expect(
      decodeKimiTranscriptLine(
        loopEvent({
          type: 'tool.call',
          uuid: 'Bash:0',
          turnId: '0',
          step: 1,
          stepUuid: 's-1',
          toolCallId: 'Bash:0',
          name: 'Bash',
          args: { command: 'ls -la' },
          description: 'Running: ls -la',
          display: { kind: 'command', command: 'ls -la', cwd: '/repo', language: 'bash' }
        }),
        'fb'
      )
    ).toEqual({
      id: 'Bash:0:fb',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'ls -la' } }],
      timestamp: 1787558237519,
      source: 'transcript',
      turnId: '0'
    })
  })

  it('decodes a tool result under a distinct id and passes output through raw', () => {
    const decoded = decodeKimiTranscriptLine(
      loopEvent({
        type: 'tool.result',
        parentUuid: 'Bash:0',
        toolCallId: 'Bash:0',
        result: { output: '  spaced output\n' }
      }),
      'fb'
    )
    expect(decoded?.id).toBe('Bash:0:fb:result')
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: '  spaced output\n' }])
  })

  it('flags an errored tool result', () => {
    const decoded = decodeKimiTranscriptLine(
      loopEvent({
        type: 'tool.result',
        parentUuid: 'Bash:0',
        toolCallId: 'Bash:0',
        result: { output: 'command failed', isError: true }
      }),
      'fb'
    )
    expect(decoded?.blocks[0]).toEqual({
      type: 'tool-result',
      output: 'command failed',
      isError: true
    })
  })

  it('survives a tool call with no args and no toolCallId', () => {
    const decoded = decodeKimiTranscriptLine(
      loopEvent({ type: 'tool.call', turnId: '0', step: 1, name: 'Read' }),
      'fb'
    )
    expect(decoded?.id).toBe('fb')
    expect(decoded?.blocks).toEqual([{ type: 'tool-call', name: 'Read', input: null }])
  })

  it('survives a numeric turnId by omitting the turn key rather than crashing', () => {
    const decoded = decodeKimiTranscriptLine(
      loopEvent({
        type: 'content.part',
        uuid: 'p-9',
        turnId: 3,
        step: 1,
        part: { type: 'text', text: 'ok' }
      }),
      'fb'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.turnId).toBeUndefined()
  })

  it('keeps a rewound session reusing the same toolCallId as distinct messages', () => {
    // Why: a rewind/resume restarts Kimi's per-session tool counter, so Bash:36
    // legitimately appears twice (observed in a real resumed session). The
    // assembler dedups on id; anchoring to the line keeps both executions.
    const call = {
      type: 'tool.call',
      turnId: '1',
      step: 9,
      toolCallId: 'Bash:36',
      name: 'Bash',
      args: { command: 'ls' }
    }
    const first = decodeKimiTranscriptLine(loopEvent(call), 'anchor-a')
    const second = decodeKimiTranscriptLine(loopEvent(call), 'anchor-b')
    expect(first?.id).toBe('Bash:36:anchor-a')
    expect(second?.id).toBe('Bash:36:anchor-b')
    expect(first?.id).not.toBe(second?.id)
  })

  it('marks a turn.cancel as an interruption, like Claude and Codex aborts', () => {
    expect(
      decodeKimiTranscriptLine(line({ type: 'turn.cancel', time: 1787601518211 }), 'fb')
    ).toEqual({
      id: 'fb',
      role: 'system',
      blocks: [{ type: 'text', text: 'Conversation interrupted' }],
      timestamp: 1787601518211,
      source: 'transcript'
    })
  })

  it('ignores a queued-prompt cancel; it interrupts nothing', () => {
    expect(
      decodeKimiTranscriptLine(
        line({ type: 'turn.cancel', target: 'queued', reason: 'user_cancelled', time: 1 }),
        'fb'
      )
    ).toBeNull()
    expect(
      decodeKimiTranscriptLine(
        line({ type: 'turn.cancel', target: 'active', reason: 'user_cancelled', time: 1 }),
        'fb'
      )?.blocks[0]
    ).toEqual({ type: 'text', text: 'Conversation interrupted' })
  })

  it('tolerates a missing or non-numeric time as a null timestamp', () => {
    expect(decodeKimiTranscriptLine(line({ type: 'turn.cancel' }), 'fb')?.timestamp).toBeNull()
    expect(
      decodeKimiTranscriptLine(
        line({
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'x' }],
          origin: { kind: 'user' },
          time: '2026-08-24T07:40:41.000Z'
        }),
        'fb'
      )?.timestamp
    ).toBe(Date.parse('2026-08-24T07:40:41.000Z'))
  })
})
