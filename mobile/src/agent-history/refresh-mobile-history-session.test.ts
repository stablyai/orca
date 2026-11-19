import { expect, it } from 'vitest'
import { refreshMobileHistorySession } from './refresh-mobile-history-session'
import { historyClient, historySession } from './mobile-history-test-fixture'

it('refreshes a cwd-less session even after 500 newer conversations arrive', async () => {
  const selected = historySession({ cwd: null })
  const newer = Array.from({ length: 500 }, (_, index) => historySession({ id: `newer-${index}` }))
  const client = historyClient(selected, async (method, params) => {
    if (method !== 'aiVault.listSessions') {
      return
    }
    const unlimited =
      params && typeof params === 'object' && 'unlimited' in params && params.unlimited === true
    return {
      id: 'reply',
      ok: true,
      result: { sessions: unlimited ? [...newer, selected] : newer, issues: [] }
    }
  })
  expect((await refreshMobileHistorySession(client, selected)).id).toBe('claude:provider')
})
