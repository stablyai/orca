import { describe, expect, it } from 'vitest'
import { listAntigravityAccounts } from './provider-account-operations'

describe('listAntigravityAccounts', () => {
  it('keeps saved accounts when one usage reading is unreadable', () => {
    const state = listAntigravityAccounts.interpret({
      id: '1',
      ok: true,
      result: {
        accounts: [
          { id: 'a', email: 'a@example.com', usage: { provider: 'antigravity', windows: 3 } },
          { id: 'b', email: null }
        ],
        activeAccountId: 'a',
        currentAccount: null,
        selectedAccountId: 'a'
      }
    })
    expect(state.accounts.map((account) => [account.id, account.usage ?? null])).toEqual([
      ['a', null],
      ['b', null]
    ])
  })
})
