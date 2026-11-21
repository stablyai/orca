import { defineMethod } from '../../core'
import { toMemorySnapshotReply } from '../../../../memory/memory-snapshot-reply'
import { remoteRpcContentBudget } from '../../../../../shared/remote-runtime/rpc/remote-rpc-content-budget'

export const DIAGNOSTICS_METHODS = [
  defineMethod({
    name: 'diagnostics.memory',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, caller, requestId }) => {
      const snapshot = await runtime.getMemorySnapshot()
      // Only remote connections cap reply size; this machine's own callers get everything.
      return caller?.kind === 'local-cli' || caller?.kind === 'desktop'
        ? snapshot
        : toMemorySnapshotReply(snapshot, remoteRpcContentBudget(requestId ?? ''))
    }
  })
]
