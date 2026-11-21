import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from '../../accounts/accounts-snapshot'
import { buildUsageWidgetSummary } from './usage-widget-summary'

const claudeSnapshot = decodeAccountsSnapshot({
  claude: {
    accounts: [{ id: 'work', email: 'me@example.com', organizationName: 'Acme' }],
    activeAccountId: 'work'
  },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: {
      provider: 'claude',
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: 5000, resetDescription: null },
      weekly: null,
      updatedAt: 1000,
      error: null,
      status: 'ok'
    },
    codex: null,
    grok: {
      provider: 'grok',
      session: null,
      weekly: { usedPercent: 64, windowMinutes: 10080, resetsAt: 9000, resetDescription: null },
      updatedAt: 1100,
      error: null,
      status: 'ok'
    },
    gemini: {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: 1100,
      error: null,
      status: 'idle'
    },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
})

const hosts = [
  { id: 'studio', name: 'Studio' },
  { id: 'laptop', name: 'Laptop' }
]

describe('buildUsageWidgetSummary', () => {
  it('keeps an offline desktop’s last usage, drops unpaired ones and providers without usage, and stores no account identity', () => {
    const summary = buildUsageWidgetSummary({
      hosts,
      liveSnapshots: { studio: claudeSnapshot },
      previous: {
        v: 2,
        display: 'used',
        hosts: [
          {
            id: 'laptop',
            name: 'Laptop',
            providers: [
              {
                provider: 'codex',
                title: 'Codex',
                updatedAt: 900,
                session: { usedPercent: 10, resetsAt: null },
                weekly: null
              }
            ]
          },
          { id: 'gone', name: 'Gone', providers: [] }
        ]
      },
      display: 'remaining'
    })

    expect(summary).toEqual({
      v: 2,
      display: 'remaining',
      hosts: [
        {
          id: 'studio',
          name: 'Studio',
          providers: [
            {
              provider: 'claude',
              title: 'Claude',
              updatedAt: 1000,
              session: { usedPercent: 42, resetsAt: 5000 },
              weekly: null
            },
            {
              provider: 'grok',
              title: 'Grok',
              updatedAt: 1100,
              session: null,
              weekly: { usedPercent: 64, resetsAt: 9000 }
            }
          ]
        },
        {
          id: 'laptop',
          name: 'Laptop',
          providers: [
            {
              provider: 'codex',
              title: 'Codex',
              updatedAt: 900,
              session: { usedPercent: 10, resetsAt: null },
              weekly: null
            }
          ]
        }
      ]
    })
  })
})
