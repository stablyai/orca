import { describe, expect, it } from 'vitest'
import { providerDiagnosticOf } from '../../shared/agent-session-failure'
import { buildCodexAppServerExitError } from './codex-app-server-exit-error'
import { PROVIDER_SPAWN_FAILURE_MARKER } from '../provider-process/provider-spawn-failure-report'

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

  it('shows a supervisor spawn failure as the spawn error a direct spawn gives', () => {
    const report = JSON.stringify({
      thrown: false,
      code: 'ENOENT',
      message: 'spawn /opt/codex ENOENT'
    })
    const error = buildCodexAppServerExitError(`${PROVIDER_SPAWN_FAILURE_MARKER}${report}\n`)

    expect(error.message).toBe('codex app-server connection ended: spawn /opt/codex ENOENT')
    expect(providerDiagnosticOf(error)?.text).toBe('spawn /opt/codex ENOENT')
  })
})
