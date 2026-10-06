import { describe, expect, it } from 'vitest'
import { providerDiagnosticOf } from '../../shared/agent-session-failure'
import { buildCodexAppServerExitError } from './codex-app-server-exit-error'

describe('buildCodexAppServerExitError', () => {
  it("keeps the stderr tail apart from Orca's wording, as log text", () => {
    const error = buildCodexAppServerExitError('  thread panicked at main.rs:4  ')
    expect(error.message).toBe('codex app-server connection ended: thread panicked at main.rs:4')
    expect(providerDiagnosticOf(error)).toEqual({
      text: 'thread panicked at main.rs:4',
      audience: 'log'
    })
  })

  it('carries no diagnostic when a cause, not the stderr, explains the end', () => {
    const error = buildCodexAppServerExitError('ignored', new Error('spawn codex ENOENT'))
    expect(providerDiagnosticOf(error)).toBeUndefined()
    expect(providerDiagnosticOf(buildCodexAppServerExitError(''))).toBeUndefined()
  })
})
