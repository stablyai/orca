import { defineMethod } from '../core'
import {
  WorkspacePortKillParams,
  WorkspacePortScanParams
} from '../../../../shared/rpc-contract/workspace-ports-params'

export const WORKSPACE_PORT_METHODS = [
  defineMethod({
    name: 'workspacePorts.scan',
    params: WorkspacePortScanParams,
    handler: async (params, { runtime }) => runtime.scanWorkspacePorts(params.repoId)
  }),
  defineMethod({
    name: 'workspacePorts.kill',
    params: WorkspacePortKillParams,
    handler: async (params, { runtime }) =>
      runtime.killWorkspacePort({
        repoId: params.repoId,
        pid: params.pid,
        port: params.port
      })
  })
]
