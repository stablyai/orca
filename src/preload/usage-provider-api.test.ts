import { describe, expect, it, vi } from 'vitest'
import { createUsageProviderApi } from './usage-provider-api'

describe('usage provider preload API', () => {
  it('keeps every provider on its existing IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const query = { scope: 'orca' as const, range: '30d' as const }

    for (const prefix of ['claudeUsage', 'codexUsage', 'openCodeUsage'] as const) {
      const api = createUsageProviderApi({ invoke } as never, prefix)
      await api.getScanState()
      await api.setEnabled({ enabled: true })
      await api.refresh()
      await api.getSnapshot({ ...query, limit: 7 })
      await api.getSummary(query)
      await api.getDaily(query)
      await api.getBreakdown({ ...query, kind: 'project' })
      await api.getRecentSessions({ ...query, limit: 4 })

      expect(invoke.mock.calls).toEqual([
        [`${prefix}:getScanState`],
        [`${prefix}:setEnabled`, { enabled: true }],
        [`${prefix}:refresh`, undefined],
        [`${prefix}:getSnapshot`, { ...query, limit: 7 }],
        [`${prefix}:getSummary`, query],
        [`${prefix}:getDaily`, query],
        [`${prefix}:getBreakdown`, { ...query, kind: 'project' }],
        [`${prefix}:getRecentSessions`, { ...query, limit: 4 }]
      ])
      invoke.mockClear()
    }
  })
})
