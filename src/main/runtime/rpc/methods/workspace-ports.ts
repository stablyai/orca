import { defineMethod } from '../core'
import {
  WorkspacePortKillHostParams,
  WorkspacePortKillParams,
  WorkspacePortScanHostParams,
  WorkspacePortScanParams
} from '../../../../shared/rpc-contract/workspace-ports-params'

export const WORKSPACE_PORT_METHODS = [
  defineMethod({
    name: 'workspacePorts.scan',
    permission: 'workspace',
    params: WorkspacePortScanParams,
    handler: async (params, { runtime }) => runtime.scanWorkspacePorts(params.repoId)
  }),
  defineMethod({
    name: 'workspacePorts.kill',
    permission: 'workspace',
    params: WorkspacePortKillParams,
    handler: async (params, { runtime }) =>
      runtime.killWorkspacePort({
        repoId: params.repoId,
        pid: params.pid,
        port: params.port
      })
  }),
  defineMethod({
    name: 'workspacePorts.scanHost',
    permission: 'workspace',
    params: WorkspacePortScanHostParams,
    handler: async (params, { runtime }) => runtime.scanWorkspacePortsOnHost(params.worktree)
  }),
  defineMethod({
    name: 'workspacePorts.killHost',
    permission: 'workspace',
    params: WorkspacePortKillHostParams,
    handler: async (params, { runtime }) =>
      runtime.killWorkspacePortOnHost({
        worktree: params.worktree,
        executionHostId: params.executionHostId,
        pid: params.pid,
        port: params.port
      })
  })
]
