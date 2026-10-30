import { describe, expect, it } from 'vitest'
import { cliErrorExitCode } from './cli-exit-code'
import { RuntimeClientError } from './runtime/types'

describe('cliErrorExitCode', () => {
  it('gives plugin commands distinct exit codes for invalid plugins and pending approval', () => {
    const plugin = ['plugin', 'dev', 'load']
    expect(cliErrorExitCode(new RuntimeClientError('plugin_invalid', 'x'), plugin)).toBe(2)
    expect(cliErrorExitCode(new RuntimeClientError('approval_required', 'x'), plugin)).toBe(3)
    expect(cliErrorExitCode(new RuntimeClientError('approval_stale', 'x'), plugin)).toBe(3)
    expect(cliErrorExitCode(new RuntimeClientError('runtime_unavailable', 'x'), plugin)).toBe(1)
    expect(cliErrorExitCode(new Error('boom'), plugin)).toBe(1)
  })

  it('keeps every other command on exit code 1', () => {
    expect(
      cliErrorExitCode(new RuntimeClientError('approval_required', 'x'), ['worktree', 'list'])
    ).toBe(1)
  })
})
