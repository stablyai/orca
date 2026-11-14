import { describe, expect, it } from 'vitest'
import { buildWindowsCommandInvocation } from './windows-command-invocation'

describe('buildWindowsCommandInvocation', () => {
  it('rejects tokens that cmd.exe cannot preserve safely', () => {
    expect(() => buildWindowsCommandInvocation('claude.cmd', ['line\nbreak'])).toThrow(
      'cannot contain quotes or line breaks'
    )
    expect(() => buildWindowsCommandInvocation('claude.cmd', ['quoted"value'])).toThrow(
      'cannot contain quotes or line breaks'
    )
  })
})
