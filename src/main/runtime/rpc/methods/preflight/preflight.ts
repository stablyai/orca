import { defineMethod } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  agentCommandOverrideDetectionOptions,
  type InstalledAgentDetectionOptions
} from '../../../../preflight/installed-agent-detection'
import { resolveQualifiedAgentDetectionHost } from './preflight-workspace-target'
import { runPreflightCheck } from '../../../../preflight/agent-detection'
import { detectRemoteWindowsTerminalCapabilities } from '../../../../ipc/preflight-remote-windows-terminal-capabilities'

import {
  assertAgentDetectionHostRunning,
  detectAgentsOnHost,
  refreshAgentsOnHost
} from '../../../../preflight/workspace-agent-detection'
import {
  PreflightAgentRefresh,
  PreflightProjectAgentDetection,
  PreflightCheck,
  PreflightDetectRemoteAgents,
  PreflightDetectRemoteWindowsTerminalCapabilities
} from '../../../../../shared/rpc-contract/preflight-params'

/** This host's command overrides, so a configured CLI outside PATH is listed like a detected one. */
function hostDetectionOptions(
  runtime: OrcaRuntimeService
): InstalledAgentDetectionOptions | undefined {
  try {
    return agentCommandOverrideDetectionOptions(
      runtime.requireStore().getSettings().agentCmdOverrides
    )
  } catch {
    // A runtime without its store still lists PATH-detected agents.
    return undefined
  }
}

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
    handler: async (params, { runtime }) => {
      if (params.project) {
        // Ungated: it serves a workspace create in that project, which boots the distro anyway.
        return runtime.detectProjectLaunchContext(params.project.repo)
      }
      const host = await resolveQualifiedAgentDetectionHost(runtime, params)
      // A client's inventory read is background work: it must not start a stopped WSL distro (E9).
      await assertAgentDetectionHostRunning(host)
      return detectAgentsOnHost(host, hostDetectionOptions(runtime))
    }
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
    params: PreflightAgentRefresh,
    handler: async (params, { runtime }) => {
      const host = await resolveQualifiedAgentDetectionHost(runtime, params)
      await assertAgentDetectionHostRunning(host)
      return refreshAgentsOnHost(host, hostDetectionOptions(runtime), params.userInitiated)
    }
  })
]
