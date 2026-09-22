import { defineMethod } from '../core'

export const STATS_METHODS = [
  defineMethod({
    name: 'stats.summary',
    params: null,
    handler: async (_params, { runtime }) => {
      return runtime.getStatsSummary() ?? {}
    }
  })
]
