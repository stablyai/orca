import { describe, expect, it } from 'vitest'
import { withoutOpenCodeStandaloneServer } from './opencode-private-server'

describe('withoutOpenCodeStandaloneServer', () => {
  it('drops the quoted flag a copied OpenCode 2 chat carries', () => {
    expect(
      withoutOpenCodeStandaloneServer("opencode '--standalone' '--session' 'ses_x'", 'posix')
    ).toBe("opencode '--session' 'ses_x'")
  })

  it.each([
    ['posix', "opencode '--standalone' 'ses_x' && other --standalone"],
    ['posix', "opencode 'ses_x'; other --standalone"],
    ['posix', "opencode 'ses_x' | other --standalone"],
    ['powershell', "opencode 'ses_x'; other --standalone"],
    ['cmd', 'opencode "ses_x" && other --standalone']
  ] as const)('does not touch a flag after a command separator (%s)', (shell, command) => {
    expect(withoutOpenCodeStandaloneServer(command, shell)).toMatch(/other --standalone$/)
  })

  it('leaves commands without the flag and other executables alone', () => {
    expect(withoutOpenCodeStandaloneServer("opencode '--session' 'ses_x'", 'posix')).toBe(
      "opencode '--session' 'ses_x'"
    )
    expect(withoutOpenCodeStandaloneServer('claude --standalone', 'posix')).toBe(
      'claude --standalone'
    )
  })
})
