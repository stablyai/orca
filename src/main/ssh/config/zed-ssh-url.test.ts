import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { resolveZedSshUrl } from './zed-ssh-url'

function createTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-1',
    label: 'Builder',
    host: 'builder.example.com',
    port: 22,
    username: 'ada',
    source: 'manual',
    ...overrides
  }
}

describe('resolveZedSshUrl', () => {
  it('keeps a custom port in the URL instead of requiring an SSH config alias', () => {
    expect(resolveZedSshUrl(createTarget({ port: 2222 }), '/srv/project')).toEqual({
      ok: true,
      url: 'ssh://ada@builder.example.com:2222/srv/project'
    })
  })

  it('uses only the alias for config-backed targets so local ssh config supplies user and port', () => {
    expect(
      resolveZedSshUrl(
        createTarget({ source: 'ssh-config', configHost: ' devbox ', port: 2222 }),
        '/srv/project'
      )
    ).toEqual({ ok: true, url: 'ssh://devbox/srv/project' })
  })

  it('percent-encodes user and path segments that would otherwise end the URL early', () => {
    expect(
      resolveZedSshUrl(
        createTarget({ username: 'ada@corp', host: '2001:db8::1' }),
        '/home/Ada Lovelace/a#b?c%d'
      )
    ).toEqual({
      ok: true,
      url: 'ssh://ada%40corp@[2001:db8::1]:22/home/Ada%20Lovelace/a%23b%3Fc%25d'
    })
  })

  it('asks for an ssh config alias when a manual host needs settings the URL cannot carry', () => {
    expect(
      resolveZedSshUrl(createTarget({ identityFile: '~/.ssh/builder', port: 2222 }), '/srv')
    ).toEqual({ ok: false, reason: 'ssh-alias-required', host: 'builder.example.com', port: 2222 })
    expect(resolveZedSshUrl(createTarget({ jumpHost: 'bastion' }), '/srv')).toMatchObject({
      reason: 'ssh-alias-required'
    })
  })

  it('refuses hosts and paths Zed cannot round-trip', () => {
    expect(
      resolveZedSshUrl(createTarget({ source: 'ssh-config', configHost: 'team devbox' }), '/srv')
    ).toEqual({ ok: false, reason: 'remote-editor-unsupported' })
    expect(resolveZedSshUrl(createTarget({ host: '-oProxyCommand=x' }), '/srv')).toMatchObject({
      reason: 'ssh-alias-required'
    })
    expect(resolveZedSshUrl(createTarget(), 'C:\\Users\\ada\\project')).toEqual({
      ok: false,
      reason: 'remote-editor-unsupported'
    })
    expect(resolveZedSshUrl(createTarget({ host: 'bad\nhost' }), '/srv')).toEqual({
      ok: false,
      reason: 'ssh-target-invalid'
    })
  })
})
