import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const WorkspaceCleanupScanParams = z
  .object({
    worktreeId: z.string().optional(),
    skipGitWorktreeIds: z.array(z.string()).optional(),
    scanId: z.string().optional()
  })
  .nullable()
  .optional()

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
  }),
  defineMethod({
    // Why: Delete Inactive Workspaces must inspect the focused runtime's repos
    // (LXC1 /root/orca/workspaces), not the empty local Mac store.
    name: 'workspaceCleanup.scan',
    params: WorkspaceCleanupScanParams,
    handler: async (params, { runtime }) => {
      return await runtime.scanWorkspaceCleanup(params ?? {})
    }
  })
]
