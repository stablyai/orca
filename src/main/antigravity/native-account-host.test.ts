import { describe, expect, it, vi } from 'vitest'
import { getAntigravityAccountService } from './native-account-host'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'

vi.mock('./native-credential-backend', () => ({ createAntigravityHostCredentialBackend: vi.fn() }))

describe('Antigravity runtime authority guard', () => {
  it.each(['Ubuntu', 'Debian', null])(
    'refuses a client-selected WSL distro (%s) before resolving a host backend',
    (wslDistro) => {
      expect(() => getAntigravityAccountService({ runtime: 'wsl', wslDistro })).toThrow(
        'host account was not changed'
      )
      expect(createAntigravityHostCredentialBackend).not.toHaveBeenCalled()
    }
  )

  it('rejects a distro accidentally attached to a host target', () => {
    expect(() => getAntigravityAccountService({ runtime: 'host', wslDistro: 'Ubuntu' })).toThrow(
      'not supported yet'
    )
    expect(createAntigravityHostCredentialBackend).not.toHaveBeenCalled()
  })
})
