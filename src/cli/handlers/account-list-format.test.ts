import { describe, expect, it } from 'vitest'
import { formatAccountsBlock } from './account-list-format'

describe('formatAccountsBlock', () => {
  it('prints the WSL guest proxy status without changing the host proxy line', () => {
    const text = formatAccountsBlock('Claude', {
      accounts: [{ id: 'a', email: 'a@example.com' }],
      activeAccountId: 'a',
      authProxy: 'on',
      wslAuthProxy: 'unsupported:wsl'
    })
    expect(text).toContain('  auth-proxy: on')
    expect(text).toContain('  wsl auth-proxy: unsupported:wsl')
  })
})
