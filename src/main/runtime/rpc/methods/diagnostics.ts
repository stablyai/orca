import { defineMethod, type RpcMethod } from '../core'

export const DIAGNOSTICS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'diagnostics.memory',
    params: null,
    handler: async (_params, { runtime }) => {
      return await runtime.getMemorySnapshot()
    }
  }),
  defineMethod({
    // Why: desktop Space / Resource Manager disk scan must run on the focused
    // runtime host (paths like /root/orca/workspaces), not on the Mac client.
    name: 'workspaceSpace.analyze',
    params: null,
    handler: async (_params, { runtime }) => {
      return await runtime.analyzeWorkspaceSpace()
    }
  })
]
