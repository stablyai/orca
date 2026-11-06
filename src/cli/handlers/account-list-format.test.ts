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

  it('labels native-chat sessions and leaves a terminal-only count unsuffixed', () => {
    const text = formatAccountsBlock('Claude', {
      accounts: [
        { id: 'a', email: 'a@example.com' },
        { id: 'b', email: 'b@example.com' }
      ],
      activeAccountId: 'a',
      assignedSessions: [
        { accountId: 'a', count: 2, chatCount: 1 },
        { accountId: 'b', count: 0 }
      ]
    })
    expect(text).toContain('  a@example.com (active)  sessions: 2 (1 chat)')
    expect(text).toContain('  b@example.com  sessions: 0')
  })
})
