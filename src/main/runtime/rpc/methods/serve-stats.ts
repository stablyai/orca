import { defineMethod } from '../core'

export const SERVE_STATS_METHODS = [
  defineMethod({
    name: 'serve.stats',
    params: null,
    handler: (_params, { runtime }) => runtime.getServeStats()
  })
]
