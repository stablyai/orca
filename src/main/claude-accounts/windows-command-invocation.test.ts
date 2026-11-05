import { describe, expect, it } from 'vitest'
import { buildWindowsCommandInvocation } from './windows-command-invocation'

describe('buildWindowsCommandInvocation', () => {
  it('preserves hostile-but-valid cmd path and argument characters', () => {
    const invocation = buildWindowsCommandInvocation(
      'C:\\Users\\space & ^ (paren) %PATH_TRAP% !bang! 한글\\claude.cmd',
      ['', 'two words', 'amp&ersand', 'caret^value', '(parentheses)', '%ARG_TRAP%', '한글-λ'],
      'C:\\Windows\\System32\\cmd.exe'
    )

    expect(invocation).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '""C:\\Users\\space & ^ (paren) "^%"PATH_TRAP"^%" !bang! 한글\\claude.cmd" "" "two words" "amp&ersand" "caret^value" "(parentheses)" ""^%"ARG_TRAP"^%"" "한글-λ""'
      ],
      windowsVerbatimArguments: true
    })
  })

  it('rejects tokens that cmd.exe cannot preserve safely', () => {
    expect(() => buildWindowsCommandInvocation('claude.cmd', ['line\nbreak'])).toThrow(
      'cannot contain quotes or line breaks'
    )
    expect(() => buildWindowsCommandInvocation('claude.cmd', ['quoted"value'])).toThrow(
      'cannot contain quotes or line breaks'
    )
  })
})
