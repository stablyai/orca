import { expect, it } from 'vitest'
import { isCodexHistorySharedForHome } from './codex-history-sharing'

it('keeps an imported account private without changing history sharing for other accounts', () => {
  const settings = {
    codexShareHistoryAcrossAccounts: true,
    codexManagedAccounts: [
      { id: 'work', managedHomePath: '/accounts/work', privateHistory: true },
      { id: 'personal', managedHomePath: '/accounts/personal' }
    ].map((account) => ({
      ...account,
      email: 'dev@example.com',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }))
  }
  expect(isCodexHistorySharedForHome(settings, '/accounts/work')).toBe(false)
  expect(isCodexHistorySharedForHome(settings, '/accounts/personal')).toBe(true)
})
