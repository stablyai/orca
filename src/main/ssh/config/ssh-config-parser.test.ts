import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { parseSshConfig } from './ssh-config-parser'
import './ssh-g-config-resolution'
import './ssh-config-host-picker'

vi.mock('os', () => ({
  homedir: () => '/home/testuser'
}))

const LARGE_HOST_ALIAS_COUNT = 150_000
const TEST_HOME = '/home/testuser'

function testHomePath(...parts: string[]): string {
  return join(TEST_HOME, ...parts)
}

function buildHostAliases(count: number): string {
  const aliases: string[] = []
  for (let index = 0; index < count; index += 1) {
    aliases.push(`generated-${index}`)
  }
  return aliases.join(' ')
}

describe('parseSshConfig', () => {
  it('keeps the first value for repeated single-valued options like OpenSSH', () => {
    const hosts = parseSshConfig(`
Host repeated
  HostName first.example.com
  HostName second.example.com
  User first-user
  User second-user
  Port 2201
  Port 2202
  IdentityAgent ~/.ssh/first-agent.sock
  IdentityAgent ~/.ssh/second-agent.sock
  IdentitiesOnly yes
  IdentitiesOnly no
  ProxyCommand ssh -W %h:%p first-bastion
  ProxyCommand ssh -W %h:%p second-bastion
  ProxyUseFdpass yes
  ProxyUseFdpass no
  ProxyJump first-jump
  ProxyJump second-jump

Host repeated-disabled
  IdentitiesOnly no
  IdentitiesOnly yes
  ProxyUseFdpass no
  ProxyUseFdpass yes
`)

    expect(hosts[0]).toEqual({
      host: 'repeated',
      hostname: 'first.example.com',
      user: 'first-user',
      port: 2201,
      identityAgent: testHomePath('.ssh', 'first-agent.sock'),
      identitiesOnly: true,
      proxyCommand: 'ssh -W %h:%p first-bastion',
      proxyUseFdpass: true,
      proxyJump: 'first-jump'
    })
    expect(hosts[1]).toEqual({
      host: 'repeated-disabled',
      identitiesOnly: false,
      proxyUseFdpass: false
    })
  })

  it('preserves ProxyCommand as the rest of the line', () => {
    const config = `
Host internal
  ProxyCommand sh -c "nc %h %p" # shell comment
`
    const hosts = parseSshConfig(config)
    expect(hosts[0].proxyCommand).toBe('sh -c "nc %h %p" # shell comment')
  })

  it('parses large concrete alias lists on one Host line', () => {
    const config = [
      `Host ${buildHostAliases(LARGE_HOST_ALIAS_COUNT)}`,
      '  HostName generated.example.com',
      'Host after',
      '  HostName after.example.com'
    ].join('\n')

    const hosts = parseSshConfig(config)

    expect(hosts).toHaveLength(LARGE_HOST_ALIAS_COUNT + 1)
    expect(hosts[0]).toEqual({
      host: 'generated-0',
      hostname: 'generated.example.com'
    })
    expect(hosts[LARGE_HOST_ALIAS_COUNT - 1]).toEqual({
      host: `generated-${LARGE_HOST_ALIAS_COUNT - 1}`,
      hostname: 'generated.example.com'
    })
    expect(hosts.at(-1)).toEqual({
      host: 'after',
      hostname: 'after.example.com'
    })
  })
})
