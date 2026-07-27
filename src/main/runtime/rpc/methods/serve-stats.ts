import { defineMethod, type RpcMethod } from '../core'

export const SERVE_STATS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'serve.stats',
    params: null,
    handler: (_params, { runtime }) => runtime.getServeStats()
  })
]
