import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { buildPlainSshTerminalArgs } from './plain-ssh-terminal-args'

const manual: SshTarget = {
  id: 't1',
  label: 'lambda',
  source: 'manual',
  host: '203.0.113.7',
  port: 2222,
  username: 'ubuntu',
  identityFile: '/home/me/.ssh/lambda key',
  jumpHost: 'bastion.example.com'
}

describe('plain SSH terminal argv', () => {
  it('logs in interactively: no -T, BatchMode or Orca multiplexing', () => {
    const args = buildPlainSshTerminalArgs(manual)
    expect(args).not.toContain('-T')
    expect(args.join(' ')).not.toMatch(/BatchMode|ControlMaster|ControlPath|ControlPersist|-S/)
    expect(args.join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile/)
  })

  it('states a manual target’s endpoint and ends with -- user@host', () => {
    expect(buildPlainSshTerminalArgs(manual)).toEqual([
      '-p',
      '2222',
      '-i',
      '/home/me/.ssh/lambda key',
      '-J',
      'bastion.example.com',
      '--',
      'ubuntu@203.0.113.7'
    ])
  })

  it('keeps a config alias bare, so Include, Match and ProxyJump in ssh_config apply', () => {
    const alias: SshTarget = {
      ...manual,
      source: 'ssh-config',
      configHost: 'lambda',
      host: 'lambda'
    }
    expect(buildPlainSshTerminalArgs(alias)).toEqual(['--', 'lambda'])
  })

  it('restores the stored endpoint only when no config block claims the alias', () => {
    const alias: SshTarget = {
      ...manual,
      source: 'ssh-config',
      configHost: 'lambda',
      host: '203.0.113.7'
    }
    expect(buildPlainSshTerminalArgs(alias, { aliasClaimedByConfig: false })).toEqual([
      '-o',
      'Hostname=203.0.113.7',
      '-p',
      '2222',
      '-l',
      'ubuntu',
      '--',
      'lambda'
    ])
  })

  it('passes Windows paths and option-like hosts as single argv elements, after --', () => {
    const windows: SshTarget = {
      ...manual,
      host: '-oProxyCommand=calc',
      username: '',
      identityFile: 'C:\\Users\\Me\\.ssh\\id ed25519',
      jumpHost: undefined,
      port: 22
    }
    const args = buildPlainSshTerminalArgs(windows)
    expect(args).toEqual(['-i', 'C:\\Users\\Me\\.ssh\\id ed25519', '--', '-oProxyCommand=calc'])
    expect(args.indexOf('--')).toBe(args.length - 2)
  })
})
