import { describe, expect, it } from 'vitest'
import { structuredSessionCliInvocation } from './cli-command'
import { formatMessagePointer } from './formatter'

describe('how a structured session invokes this app’s CLI, per shell', () => {
  it.each([
    ['darwin', 'claude', '"$ORCA_CLI_COMMAND"'],
    ['darwin', 'codex', '"$ORCA_CLI_COMMAND"'],
    ['linux', 'claude', '"$ORCA_CLI_COMMAND"'],
    ['linux', 'codex', '"$ORCA_CLI_COMMAND"'],
    // Claude's command tool runs in Git Bash on Windows: still a POSIX expansion.
    ['win32', 'claude', '"$ORCA_CLI_COMMAND"'],
    // Codex's defaults to PowerShell on Windows, where "$X" is a PS variable and a quoted string
    // followed by arguments does not parse; the env var is `$env:X`, invoked with `&`.
    ['win32', 'codex', '& $env:ORCA_CLI_COMMAND']
  ] as const)('%s / %s → %s', (platform, provider, invocation) => {
    expect(structuredSessionCliInvocation({ platform, provider })).toBe(invocation)
  })

  it('renders a pointer each shell can run as written', () => {
    expect(
      formatMessagePointer(
        1,
        'run:run_1',
        structuredSessionCliInvocation({ platform: 'win32', provider: 'codex' })
      ).trim()
    ).toBe(
      'You have 1 orchestration message. Run `& $env:ORCA_CLI_COMMAND orchestration check --run run_1`.'
    )
    expect(
      formatMessagePointer(
        1,
        'session:s1',
        structuredSessionCliInvocation({ platform: 'darwin', provider: 'codex' })
      ).trim()
    ).toBe('You have 1 orchestration message. Run `"$ORCA_CLI_COMMAND" orchestration check`.')
  })
})
