import { defineMethod } from '../core'
import {
  detectRemoteWindowsTerminalCapabilities,
  runPreflightCheck
} from '../../../preflight/agent-detection'
import {
  detectAgentsOnHost,
  refreshAgentsOnHost
} from '../../../preflight/workspace-agent-detection'
import {
  PreflightAgentDetection,
  PreflightProjectAgentDetection,
  PreflightCheck,
  PreflightDetectRemoteAgents,
  PreflightDetectRemoteWindowsTerminalCapabilities
} from '../../../../shared/rpc-contract/preflight-params'

export const PREFLIGHT_METHODS = [
  defineMethod({
    name: 'preflight.check',
    permission: 'workspace',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    permission: 'workspace',
    params: PreflightProjectAgentDetection,
    // Only the host knows the workspace's actual project runtime, including WSL.
    handler: async (params, { runtime }) =>
      params.project
        ? runtime.detectProjectLaunchContext(params.project.repo)
        : detectAgentsOnHost(
            await runtime.resolveAgentDetectionHost(params.worktreeId, params.repoId)
          )
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    permission: 'workspace',
    params: PreflightDetectRemoteAgents,
    handler: async (params) =>
      detectAgentsOnHost({ kind: 'ssh', connectionId: params.connectionId })
  }),
  defineMethod({
    name: 'preflight.detectRemoteWindowsTerminalCapabilities',
    permission: 'workspace',
    params: PreflightDetectRemoteWindowsTerminalCapabilities,
    handler: async (params) => detectRemoteWindowsTerminalCapabilities(params)
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    permission: 'workspace',
    params: PreflightAgentDetection,
    handler: async (params, { runtime }) =>
      refreshAgentsOnHost(await runtime.resolveAgentDetectionHost(params.worktreeId, params.repoId))
  })
]
