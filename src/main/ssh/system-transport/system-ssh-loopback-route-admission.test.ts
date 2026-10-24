import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  admitSystemSshLoopbackRoute,
  agentListingMayHoldSecurityKey
} from './system-ssh-loopback-route-admission'
import { findSystemSsh } from './system-ssh-binary'

const target: SshTarget = {
  id: 'target-1',
  label: 'Dev box',
  host: 'devbox',
  configHost: 'devbox',
  port: 22,
  username: '',
  source: 'ssh-config'
}
// Real OpenSSH: the drift is in how ssh_config matches, which only OpenSSH can answer.
describe.skipIf(findSystemSsh() === null)('admitSystemSshLoopbackRoute with real ssh -G', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-loopback-admission-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function writeConfig(name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it('refuses a route under which a `Match host` block would log in as another user', async () => {
    const configFile = writeConfig(
      'match-host',
      [
        'Host devbox',
        '  HostName devbox.internal',
        '  ProxyJump bastion',
        '  IdentityAgent none',
        'Match host devbox.internal',
        '  User route_user',
        ''
      ].join('\n')
    )

    await expect(admitSystemSshLoopbackRoute(target, { configFile })).resolves.toEqual({
      admitted: false,
      reason: 'route changes user'
    })
  })

  it.each([
    ['a %h token, which a routed login expands to 127.0.0.1', '~/.ssh/id_%h'],
    ['an environment reference ssh -G leaves unexpanded', '${ORCA_TEST_KEY_DIR}/id_sk']
  ])('refuses a route with %s', async (_name, identityFile) => {
    const configFile = writeConfig(
      `token-${identityFile.length}`,
      [
        'Host devbox',
        '  HostName devbox.internal',
        '  ProxyJump bastion',
        '  IdentityAgent none',
        `  IdentityFile ${identityFile}`,
        ''
      ].join('\n')
    )

    await expect(admitSystemSshLoopbackRoute(target, { configFile })).resolves.toMatchObject({
      admitted: false,
      reason: expect.stringContaining('identityfile')
    })
  })

  it('refuses a route whose jump host signs with a security key', async () => {
    const skKey = join(dir, 'bastion_sk')
    writeFileSync(
      `${skKey}.pub`,
      'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t bastion\n'
    )
    const configFile = writeConfig(
      'jump-sk',
      [
        'Host devbox',
        '  HostName devbox.internal',
        '  ProxyJump bastion',
        '  IdentityAgent none',
        'Host bastion',
        `  IdentityFile ${skKey}`,
        '  IdentitiesOnly yes',
        '  IdentityAgent none',
        ''
      ].join('\n')
    )

    await expect(admitSystemSshLoopbackRoute(target, { configFile })).resolves.toEqual({
      admitted: false,
      reason: 'jump host bastion may use a security key'
    })
  })

  // Why: OpenSSH still applies a manual host's own Host block, so the forward must use what it resolved.
  it("takes a manual target's sshd and known_hosts name from its Host block", async () => {
    const configFile = writeConfig(
      'manual-remap',
      [
        'Host myhost',
        '  HostName 10.0.0.5',
        '  Port 2200',
        '  IdentityAgent none',
        'Host bastion',
        '  IdentityFile /nonexistent/orca-admission-key',
        '  IdentityAgent none',
        ''
      ].join('\n')
    )
    const manual: SshTarget = {
      ...target,
      host: 'myhost',
      configHost: 'myhost',
      source: 'manual',
      jumpHost: 'bastion'
    }

    await expect(admitSystemSshLoopbackRoute(manual, { configFile })).resolves.toEqual({
      admitted: true,
      sshdPort: 2200,
      hostKeyAlias: '[10.0.0.5]:2200'
    })
  })

  it('admits a route that changes only how the host is reached', async () => {
    const configFile = writeConfig(
      'plain',
      [
        'Host devbox',
        '  HostName devbox.internal',
        '  User route_user',
        '  ProxyJump bastion',
        '  IdentityAgent none',
        'Host bastion',
        '  IdentityFile /nonexistent/orca-admission-key',
        '  IdentityAgent none',
        ''
      ].join('\n')
    )

    await expect(admitSystemSshLoopbackRoute(target, { configFile })).resolves.toEqual({
      admitted: true,
      sshdPort: 22,
      hostKeyAlias: 'devbox.internal'
    })
  })
})

describe('agentListingMayHoldSecurityKey', () => {
  const listing = (code: number | null, stdout = '', timedOut = false) => ({
    code,
    stdout,
    timedOut
  })

  it.each([
    ['an sk- key in the agent', listing(0, 'sk-ssh-ed25519@openssh.com AAAA k\n'), false, true],
    ['only ordinary agent keys', listing(0, 'ssh-ed25519 AAAA k\n'), false, false],
    ['an agent with no identities', listing(1), false, false],
    ['no default agent to sign with', listing(2), false, false],
    ['an unreachable configured IdentityAgent', listing(2), true, true],
    ['an agent query that timed out', listing(null, '', true), false, true]
  ])('%s → %s', (_name, result, agentConfigured, expected) => {
    expect(agentListingMayHoldSecurityKey(result, agentConfigured)).toBe(expected)
  })
})
