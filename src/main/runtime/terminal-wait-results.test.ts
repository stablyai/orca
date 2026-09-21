import { describe, expect, it } from 'vitest'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from './terminal-wait-results'

describe('terminal wait results', () => {
  it('preserves exit provenance for every wait result shape', () => {
    const terminal = {
      connected: false,
      lastExitCode: 0,
      lastExitCause: { kind: 'operator_close' as const }
    }
    const results = [
      buildTerminalWaitResult('terminal', 'exit', terminal),
      buildTerminalWaitBlockedResult('terminal', 'exit', terminal, 'agent-approval-prompt'),
      buildPtyTerminalWaitResult('pty', 'exit', terminal),
      buildPtyTerminalWaitBlockedResult('pty', 'exit', terminal, 'agent-approval-prompt')
    ]

    expect(results.map((result) => result.exitCause)).toEqual([
      { kind: 'operator_close' },
      { kind: 'operator_close' },
      { kind: 'operator_close' },
      { kind: 'operator_close' }
    ])
  })
})
