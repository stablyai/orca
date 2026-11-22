import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from '../../accounts/accounts-snapshot'
import { buildUsageWidgetSummary } from './usage-widget-summary'

const studioSnapshot = decodeAccountsSnapshot({
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

const laptopCodex = {
  provider: 'codex',
  updatedAt: 900,
  session: { usedPercent: 10, resetsAt: null },
  weekly: null
}

describe('buildUsageWidgetSummary', () => {
  it('keeps an offline desktop’s last usage, drops unpaired ones and providers without usage, and stores no account identity', () => {
    const summary = buildUsageWidgetSummary({
      hosts: [
        { id: 'studio', name: 'Studio' },
        { id: 'laptop', name: 'Laptop' }
      ],
      liveSnapshots: { studio: studioSnapshot },
      previous: {
        hosts: [
          { id: 'laptop', name: 'Laptop', providers: [laptopCodex] },
          { id: 'gone', name: 'Gone', providers: [laptopCodex] }
        ]
      }
    })

    expect(summary).toEqual({
      hosts: [
        {
          id: 'studio',
          name: 'Studio',
          providers: [
            {
              provider: 'claude',
              updatedAt: 1000,
              session: { usedPercent: 42, resetsAt: 5000 },
              weekly: null
            },
            {
              provider: 'grok',
              updatedAt: 1100,
              session: null,
              weekly: { usedPercent: 64, resetsAt: 9000 }
            }
          ]
        },
        { id: 'laptop', name: 'Laptop', providers: [laptopCodex] }
      ]
    })
  })
})
