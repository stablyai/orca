import { defineMethod } from '../../core'
import { toMemorySnapshotReply } from '../../../../memory/memory-snapshot-reply'

export const DIAGNOSTICS_METHODS = [
  defineMethod({
    name: 'diagnostics.memory',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => {
      return toMemorySnapshotReply(await runtime.getMemorySnapshot())
    }
  })
]
