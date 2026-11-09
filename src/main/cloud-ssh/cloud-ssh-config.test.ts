import { describe, expect, it } from 'vitest'
import {
  cloudSshAlias,
  cloudSshCommandLine,
  cloudSshKeyComment,
  renderCloudSshConfig,
  renderCloudSshKnownHosts
} from './cloud-ssh-config'
import { HOSTED_SANDBOX_SSH_PUBLIC_KEY } from '../../shared/hosted-sandbox/hosted-sandbox-wire'

const HOST_KEY = `ssh-ed25519 ${'H'.repeat(68)}`
const entry = {
  alias: 'orca-fix-login-bug-4f2a',
  identityFile: '/Users/me/Library/Application Support/orca/cloud-ssh/keys/orca-fix-login-bug-4f2a',
  user: 'vercel-sandbox',
  port: 2222,
  hostKey: HOST_KEY,
  proxyTarget: 'evm-123'
}

describe('cloudSshAlias', () => {
  it('reads like the workspace and stays unique per sandbox', () => {
    expect(cloudSshAlias('Fix login bug!', 'sbx_04af41afa508453a12018d01')).toBe(
      'orca-fix-login-bug-8d01'
    )
    expect(cloudSshAlias(undefined, 'sbx_1')).toBe('orca-workspace-sbx1')
    expect(cloudSshAlias('ünïcode ✨ name', 'abcd')).toBe('orca-unicode-name-abcd')
  })

  it('keeps long names to a host name editors list cleanly', () => {
    const alias = cloudSshAlias('a'.repeat(200), 'sbx_ffff')
    expect(alias.length).toBeLessThanOrEqual(5 + 32 + 5)
  })
})

describe('cloudSshKeyComment', () => {
  it('names device and workspace in a form the VM accepts', () => {
    const comment = cloudSshKeyComment("Neil's MacBook Pro", 'orca-fix-login-bug-4f2a')
    expect(comment).toBe('orca:neil-s-macbook-pro:orca-fix-login-bug-4f2a')
    expect(`ssh-ed25519 ${'A'.repeat(68)} ${comment}`).toMatch(HOSTED_SANDBOX_SSH_PUBLIC_KEY)
  })
})

describe('renderCloudSshConfig', () => {
  const config = renderCloudSshConfig({
    entries: [entry],
    knownHostsFile: '/Users/me/Library/Application Support/orca/cloud-ssh/known_hosts',
    cliCommand: '/Applications/Orca.app/Contents/Resources/bin/orca'
  })

  it('tunnels through orca ssh-proxy with a pinned host key and only Orca’s key', () => {
    expect(config).toContain('Host orca-fix-login-bug-4f2a\n')
    expect(config).toContain(
      '  ProxyCommand "/Applications/Orca.app/Contents/Resources/bin/orca" ssh-proxy evm-123\n'
    )
    expect(config).toContain('  StrictHostKeyChecking yes\n')
    expect(config).toContain('  HostKeyAlias orca-fix-login-bug-4f2a\n')
    expect(config).toContain('  IdentitiesOnly yes\n')
    expect(config).toContain('  IdentityAgent none\n')
    expect(config).toContain('  PasswordAuthentication no\n')
    // A global `ForwardAgent` must not hand the user's keys to agents in the VM.
    expect(config).toContain('  ForwardAgent no\n')
    expect(config).toContain('  ForwardX11 no\n')
  })

  it('doubles % so ssh does not expand tokens in paths, and pins the app profile', () => {
    const rendered = renderCloudSshConfig({
      entries: [{ ...entry, identityFile: '/home/me/100%/key' }],
      knownHostsFile: '/tmp/kh',
      cliCommand: '/opt/orca',
      userDataPath: '/home/me/.config/orca'
    })
    expect(rendered).toContain('  IdentityFile "/home/me/100%%/key"\n')
    expect(rendered).toContain(
      '  ProxyCommand env ORCA_USER_DATA_PATH="/home/me/.config/orca" "/opt/orca" ssh-proxy evm-123\n'
    )
  })

  it('quotes paths with spaces', () => {
    expect(config).toContain(
      '  IdentityFile "/Users/me/Library/Application Support/orca/cloud-ssh/keys/orca-fix-login-bug-4f2a"\n'
    )
    expect(config).toContain(
      '  UserKnownHostsFile "/Users/me/Library/Application Support/orca/cloud-ssh/known_hosts"\n'
    )
  })

  it('refuses values that would break out of a quoted ssh_config value', () => {
    expect(() =>
      renderCloudSshConfig({
        entries: [{ ...entry, identityFile: '/tmp/a"\nHost *\n  ProxyCommand evil' }],
        knownHostsFile: '/tmp/kh',
        cliCommand: 'orca'
      })
    ).toThrow()
  })

  it.each(['/tmp/$(id)', '/tmp/`id`', '/tmp/a\\b'])('refuses shell-expandable path %s', (path) => {
    expect(() =>
      renderCloudSshConfig({ entries: [entry], knownHostsFile: '/tmp/kh', cliCommand: path })
    ).toThrow()
  })

  it('skips anything that is not an Orca alias', () => {
    const rendered = renderCloudSshConfig({
      entries: [{ ...entry, alias: '*' }],
      knownHostsFile: '/tmp/kh',
      cliCommand: 'orca'
    })
    expect(rendered).not.toContain('Host *')
  })
})

describe('renderCloudSshKnownHosts', () => {
  it('pins each host key under its alias', () => {
    expect(renderCloudSshKnownHosts([entry])).toBe(`orca-fix-login-bug-4f2a ${HOST_KEY}\n`)
  })
})

describe('cloudSshCommandLine', () => {
  it('pastes into a shell as is, without editing ~/.ssh/config', () => {
    expect(
      cloudSshCommandLine(
        '/Users/me/Library/Application Support/orca/cloud-ssh/config',
        'orca-x-0001'
      )
    ).toBe("ssh -F '/Users/me/Library/Application Support/orca/cloud-ssh/config' orca-x-0001")
    expect(cloudSshCommandLine('/home/me/.config/orca/cloud-ssh/config', 'orca-x-0001')).toBe(
      'ssh -F /home/me/.config/orca/cloud-ssh/config orca-x-0001'
    )
  })
})
