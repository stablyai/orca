import { expect, it } from 'vitest'
import { buildMobileAgentHistorySections } from './agent-history-sections'
import { historySession } from './mobile-history-test-fixture'

it.each(['', 'provider'])(
  'keeps the chat picker restricted to its provider session when search is %j',
  (query) => {
    const rows = [
      historySession(),
      historySession({
        id: 'claude:other',
        sessionId: 'other',
        previewMessages: [{ role: 'assistant', text: 'Quotes provider', timestamp: null }]
      })
    ]
    const sections = buildMobileAgentHistorySections(rows, {
      query,
      providerSessionId: 'provider',
      agents: ['claude'],
      sort: 'updated',
      scope: 'all',
      scopeFilterPaths: [],
      activeWorktreePath: '/repo',
      now: 0
    })
    expect(sections.flatMap((section) => section.data.map((row) => row.id))).toEqual([
      'claude:provider'
    ])
  }
)
