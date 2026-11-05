import { defineMethod } from '../core'

export const STATS_METHODS = [
  defineMethod({
    name: 'stats.summary',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => {
      return runtime.getStatsSummary() ?? {}
    }
  }),
  defineMethod({
    name: 'stats.claudeStatsCache',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => runtime.getClaudeStatsCache()
  })
]
