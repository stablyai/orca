import { defineMethod } from '../../core'
import { toPairedMemoryReply } from '../../../../memory/memory-snapshot-paired-reply'

export const DIAGNOSTICS_METHODS = [
  defineMethod({
    name: 'diagnostics.memory',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, caller }) => {
      const snapshot = await runtime.getMemorySnapshot()
      // Paired machines get terminals only, as before; chat detail stays on this machine for now.
      return caller?.kind === 'local-cli' || caller?.kind === 'desktop'
        ? snapshot
        : toPairedMemoryReply(snapshot)
    }
  })
]
