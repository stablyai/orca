import { defineMethod } from '../core'

export const DIAGNOSTICS_METHODS = [
  defineMethod({
    name: 'diagnostics.memory',
    params: null,
    handler: async (_params, { runtime }) => {
      return await runtime.getMemorySnapshot()
    }
  })
]
