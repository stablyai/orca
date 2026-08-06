import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveVsCodeSshAuthority } from './vscode-ssh-authority'

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

describe('resolveVsCodeSshAuthority', () => {
  it('uses the config host for imported and legacy OpenSSH targets', () => {
    expect(
      resolveVsCodeSshAuthority(createTarget({ source: 'ssh-config', configHost: ' builder ' }))
    ).toEqual({ ok: true, authority: 'builder' })
    expect(
      resolveVsCodeSshAuthority(
        createTarget({ source: undefined, configHost: 'legacy-builder', host: '192.0.2.10' })
      )
    ).toEqual({ ok: true, authority: 'legacy-builder' })
  })

  it('does not treat a manual target configHost default as an alias', () => {
    expect(
      resolveVsCodeSshAuthority(
        createTarget({ configHost: 'builder.example.com', port: 22, source: 'manual' })
      )
    ).toEqual({ ok: true, authority: 'ada@builder.example.com' })
  })

  it.each(['', '   '])(
    'uses a host-only authority for a manual port-22 target without a username',
    (username) => {
      expect(resolveVsCodeSshAuthority(createTarget({ username }))).toEqual({
        ok: true,
        authority: 'builder.example.com'
      })
    }
  )

  it('requires an alias for manual targets on non-default ports', () => {
    expect(
      resolveVsCodeSshAuthority(
        createTarget({ configHost: 'builder.example.com', port: 2222, source: 'manual' })
      )
    ).toEqual({
      ok: false,
      reason: 'ssh-alias-required',
      host: 'builder.example.com',
      port: 2222
    })
  })

  it.each([
    createTarget({ host: ' ' }),
    createTarget({ host: 'builder\nmalicious' }),
    createTarget({ username: '\n' }),
    createTarget({ username: 'ada\nmalicious' }),
    createTarget({ source: 'ssh-config', configHost: '\u0000builder' }),
    createTarget({ port: 0 })
  ])('rejects invalid or unsafe target fields', (target) => {
    expect(resolveVsCodeSshAuthority(target)).toEqual({
      ok: false,
      reason: 'ssh-target-invalid'
    })
  })
})
