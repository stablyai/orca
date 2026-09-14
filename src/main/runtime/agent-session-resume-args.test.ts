import { describe, expect, it } from 'vitest'
import { resolveAgentSessionResumeArgs } from './agent-session-resume-args'

describe('agent session resume arguments', () => {
  it('keeps the session creation arguments after mutable defaults change', () => {
    expect(
      resolveAgentSessionResumeArgs({
        persistedArgs: ['--model', 'claude-created'],
        defaultArgs: '--model claude-current',
        shell: 'posix'
      })
    ).toBe("'--model' 'claude-created'")
  })

  it('keeps an explicit empty snapshot when defaults are toggled off', () => {
    expect(
      resolveAgentSessionResumeArgs({
        persistedArgs: [],
        defaultArgs: '--dangerously-skip-permissions',
        shell: 'posix'
      })
    ).toBe('')
  })

  it('uses current defaults for legacy records without a snapshot', () => {
    expect(
      resolveAgentSessionResumeArgs({
        defaultArgs: '--dangerously-skip-permissions',
        shell: 'posix'
      })
    ).toBe('--dangerously-skip-permissions')
  })
})
