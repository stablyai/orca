import { defineMethod } from '../../core'
import {
  WorkspacePortKillHostParams,
  WorkspacePortKillParams,
  WorkspacePortProbePageParams,
  WorkspacePortScanHostParams,
  WorkspacePortScanParams
} from '../../../../../shared/rpc-contract/workspaces/workspace-ports-params'
import { probeWorkspacePortPage } from '../../../../ports/workspace-port-page-probe'

export const WORKSPACE_PORT_METHODS = [
  defineMethod({
    name: 'workspacePorts.scan',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkspacePortScanParams,
    handler: async (params, { runtime }) => runtime.scanWorkspacePorts(params.repoId)
  }),
  defineMethod({
    name: 'workspacePorts.kill',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkspacePortKillParams,
    handler: async (params, { runtime }) =>
      runtime.killWorkspacePort({
        repoId: params.repoId,
        pid: params.pid,
        port: params.port
      })
  }),
  defineMethod({
    name: 'workspacePorts.probePage',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkspacePortProbePageParams,
    handler: async (params) => probeWorkspacePortPage(params)
  }),
  defineMethod({
    name: 'workspacePorts.scanHost',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkspacePortScanHostParams,
    handler: async (params, { runtime }) => runtime.scanWorkspacePortsOnHost(params.worktree)
  }),
  defineMethod({
    name: 'workspacePorts.killHost',
    permission: 'workspace',
    share: 'not-shared',
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
