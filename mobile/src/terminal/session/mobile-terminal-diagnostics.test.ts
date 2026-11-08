import { describe, expect, it } from 'vitest'
import { getMobileTerminalDiagnosticErrorName } from './mobile-terminal-diagnostics'

describe('mobile terminal diagnostics', () => {
  it('reports thrown error types without copying potentially sensitive messages', () => {
    expect(getMobileTerminalDiagnosticErrorName(new TypeError('/private/worktree failed'))).toBe(
      'TypeError'
    )
    expect(getMobileTerminalDiagnosticErrorName('raw failure')).toBe('string')
  })
})
