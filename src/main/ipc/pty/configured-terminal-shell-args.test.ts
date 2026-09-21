import { describe, expect, it } from 'vitest'
import { resolveConfiguredTerminalShellArgs } from './configured-terminal-shell-args'

const profile = {
  connectionId: undefined,
  requestedShellOverride: undefined,
  launchCommand: undefined
}

describe('resolveConfiguredTerminalShellArgs', () => {
  it('forwards the configured argument list, including an explicit empty one', () => {
    expect(
      resolveConfiguredTerminalShellArgs({
        ...profile,
        settings: { terminalDefaultShell: '/bin/bash', terminalDefaultShellArgs: [] }
      })
    ).toEqual([])
    expect(
      resolveConfiguredTerminalShellArgs({
        ...profile,
        settings: {
          terminalDefaultShell: '/bin/bash',
          terminalDefaultShellArgs: ['--rcfile', '/tmp/rc']
        }
      })
    ).toEqual(['--rcfile', '/tmp/rc'])
  })

  it('falls back to the controlled default when no profile is configured', () => {
    expect(
      resolveConfiguredTerminalShellArgs({
        ...profile,
        settings: { terminalDefaultShell: '/bin/bash' }
      })
    ).toBeUndefined()
    expect(
      resolveConfiguredTerminalShellArgs({
        ...profile,
        settings: { terminalDefaultShell: '  ', terminalDefaultShellArgs: [] }
      })
    ).toBeUndefined()
    expect(resolveConfiguredTerminalShellArgs({ ...profile, settings: undefined })).toBeUndefined()
  })

  it.each([
    { connectionId: 'ssh-host' },
    { requestedShellOverride: '/bin/fish' },
    { launchCommand: 'codex' }
  ])('ignores the profile for %o', (overrides) => {
    expect(
      resolveConfiguredTerminalShellArgs({
        ...profile,
        ...overrides,
        settings: { terminalDefaultShell: '/bin/bash', terminalDefaultShellArgs: [] }
      })
    ).toBeUndefined()
  })
})
