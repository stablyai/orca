import { describe, expect, it } from 'vitest'
import { classifySessionDeleteResult } from './session-delete-command'

describe('classifySessionDeleteResult', () => {
  it('treats a successful exit as deleted', () => {
    expect(classifySessionDeleteResult({ code: 0, output: '', timedOut: false })).toEqual({
      outcome: 'deleted'
    })
  })

  it('treats an already-missing session as gone', () => {
    expect(
      classifySessionDeleteResult({
        code: 1,
        output: "No active or archived session found matching 'x'",
        timedOut: false
      })
    ).toEqual({ outcome: 'not-found' })
    expect(
      classifySessionDeleteResult({ code: 1, output: 'Session not found: ses_x', timedOut: false })
    ).toEqual({ outcome: 'not-found' })
  })

  it('reports timeouts, spawn failures and other nonzero exits as failures', () => {
    expect(classifySessionDeleteResult({ code: null, output: '', timedOut: true })).toMatchObject({
      outcome: 'failed'
    })
    expect(
      classifySessionDeleteResult({
        code: null,
        output: '',
        timedOut: false,
        spawnError: 'spawn codex ENOENT'
      })
    ).toEqual({ outcome: 'failed', error: 'spawn codex ENOENT' })
    expect(
      classifySessionDeleteResult({ code: 1, output: 'failed to delete session', timedOut: false })
    ).toEqual({ outcome: 'failed', error: 'failed to delete session' })
  })
})
