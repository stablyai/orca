import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  WorkspaceServerStartParams,
  WorkspaceServerStopParams,
  WorkspaceServerScopeParams,
  WorkspacePortKillHostParams,
  WorkspacePortKillParams,
  WorkspacePortProbePageParams,
  WorkspacePortScanHostParams,
  WorkspacePortScanParams
} from '../../../../shared/rpc-contract/workspace-ports-params'
import { probeWorkspacePortPage } from '../../../ports/workspace-port-page-probe'

export const WORKSPACE_PORT_METHODS = [
  defineMethod({
    name: 'workspaceServers.start',
    permission: 'workspace',
    params: WorkspaceServerStartParams,
    handler: async (params, { runtime }) => runtime.startManagedWorkspaceServer(params)
  }),
  defineMethod({
    name: 'workspaceServers.stop',
    permission: 'workspace',
    params: WorkspaceServerStopParams,
    handler: async (params, { runtime }) => {
      const scope = await runtime.resolveWorkspaceServerScope(
        params.worktree,
        params.executionHostId
      )
      return runtime.workspaceServers.stop(scope.id, params.port, params.runId)
    }
  }),
  defineStreamingMethod({
    name: 'workspaceServers.subscribe',
    permission: 'workspace',
    params: WorkspaceServerScopeParams,
    handler: async (params, ctx, emit) => {
      const scope = await ctx.runtime.resolveWorkspaceServerScope(
        params.worktree,
        params.executionHostId
      )
      let dispose = () => {}
      const id = `workspace-servers:${ctx.connectionId ?? 'local'}:${ctx.requestId ?? ''}`
      const stream = bindStructuredAgentSessionStream(ctx, id, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = ctx.runtime.workspaceServers.subscribe(scope.id, emit)
      if (stream.isClosed()) {
        dispose()
      }
    }
  }),
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
    name: 'workspacePorts.probePage',
    permission: 'workspace',
    params: WorkspacePortProbePageParams,
    handler: async (params) => probeWorkspacePortPage(params)
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
