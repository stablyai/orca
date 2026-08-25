import { describe, expect, it } from 'vitest'
import { PI_IDLE_TITLE, PI_WORKING_TITLE, renderPiEvent, sanitizeForTerminal } from './renderer'

const secrets = ['task_secret', 'ctx_secret', 'term_secret', 'cap_secret']

describe('sanitized Pi worker rendering', () => {
  it('removes terminal controls, routing secrets, and raw JSON', () => {
    expect(
      sanitizeForTerminal('\u001b]0;stolen\u0007hello \u001b[31mtask_secret\u001b[0m', secrets)
    ).toBe('hello [redacted]')
    expect(sanitizeForTerminal('{"capability":"cap_secret"}', secrets)).toBe(
      '[structured output omitted]'
    )
  })

  it('renders only assistant text deltas and never raw event JSON', () => {
    expect(
      renderPiEvent(
        {
          type: 'message_update',
          private: { capability: 'cap_secret' },
          assistantMessageEvent: { type: 'text_delta', delta: 'Safe task_secret text' }
        },
        secrets
      )
    ).toEqual({ output: 'Safe [redacted] text' })
    expect(
      renderPiEvent(
        {
          type: 'tool_execution_start',
          toolCallId: 'call_private',
          toolName: 'bash',
          args: { command: 'echo cap_secret' }
        },
        secrets
      )
    ).toEqual({ output: '\n[tool] bash\n' })
  })

  it('emits recognized Pi working and idle OSC titles', () => {
    expect(renderPiEvent({ type: 'agent_start' }, secrets)).toEqual({ title: PI_WORKING_TITLE })
    expect(renderPiEvent({ type: 'agent_settled' }, secrets)).toEqual({ title: PI_IDLE_TITLE })
    expect(PI_WORKING_TITLE).toContain('⠋ π - Orca worker')
    expect(PI_IDLE_TITLE).toContain('π - Orca worker')
  })
})
