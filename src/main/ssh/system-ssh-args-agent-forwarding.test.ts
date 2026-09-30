import { describe, expect, it } from 'vitest'
import { buildSshArgs } from './system-ssh-args'
import { createTarget } from './ssh-connection-test-fixtures'

function forwardAgentArgs(args: string[]): string[] {
  return args.filter((arg) => arg.startsWith('ForwardAgent='))
}

describe('buildSshArgs agent forwarding', () => {
  it('passes an explicit per-host choice to OpenSSH', () => {
    expect(forwardAgentArgs(buildSshArgs(createTarget({ forwardAgent: true })))).toEqual([
      'ForwardAgent=yes'
    ])
    // "Off" must also beat a `Host *` ForwardAgent in the user's ssh_config.
    expect(forwardAgentArgs(buildSshArgs(createTarget({ forwardAgent: false })))).toEqual([
      'ForwardAgent=no'
    ])
    expect(forwardAgentArgs(buildSshArgs(createTarget()))).toEqual([])
  })

  it('leaves ForwardAgent to ssh_config for config-backed targets', () => {
    const args = buildSshArgs(
      createTarget({ source: 'ssh-config', configHost: 'work', host: 'work', forwardAgent: true })
    )
    expect(forwardAgentArgs(args)).toEqual([])
  })
})
