import { describe, expect, it } from 'vitest'
import { claudeResultOutcome } from './claude-result-outcome'

describe('claudeResultOutcome', () => {
  it.each(['aborted_tools', 'aborted_streaming'])(
    'reads a step a steer cut short (%s, is_error false) as interrupted, not completed',
    (terminal_reason) => {
      expect(
        claudeResultOutcome({
          type: 'result',
          subtype: 'success',
          is_error: false,
          terminal_reason
        })
      ).toBe('cancellation')
    }
  )

  it('still reads an unaborted result as success', () => {
    expect(
      claudeResultOutcome({
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed'
      })
    ).toBe('success')
  })
})
