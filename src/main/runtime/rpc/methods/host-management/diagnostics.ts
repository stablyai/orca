import { defineMethod } from '../../core'
import { toMemorySnapshotReply } from '../../../../memory/memory-snapshot-reply'

export const DIAGNOSTICS_METHODS = [
  defineMethod({
    name: 'diagnostics.memory',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, caller }) => {
      const snapshot = await runtime.getMemorySnapshot()
      // Only remote connections cap reply size; this machine's own callers get everything.
      return caller?.kind === 'local-cli' || caller?.kind === 'desktop'
        ? snapshot
        : toMemorySnapshotReply(snapshot)
    }
  })
]
