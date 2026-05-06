import { defineMethod, type RpcMethod } from '../core'

export const STATS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'stats.summary',
    params: null,
    handler: async (_params, { runtime }) => {
      return runtime.getStatsSummary() ?? {}
    }
  })
]
