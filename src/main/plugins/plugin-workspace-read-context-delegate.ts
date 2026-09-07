import { buildHostLabelById } from '../../shared/worktree/host-context-labels'
import {
  projectPluginAgentContext,
  projectPluginExecutionHost,
  selectPluginAgentLabels,
  type PluginAgentStatusSnapshot
} from '../../shared/plugins/plugin-workspace-read-context'
import { readActiveOrcaProfileLabel } from './plugin-orca-profile-label'
import type {
  PluginRuntimeDelegate,
  PluginWorkspaceReadContextSources
} from './plugin-host-service-bindings'

export function createPluginWorkspaceReadContextSources(input: {
  listSshTargets: () => readonly { id: string; label: string }[]
  getHostSettingOverrides: () => unknown
  listAgentStatuses: () => readonly PluginAgentStatusSnapshot[]
  userDataPath: string
}): PluginWorkspaceReadContextSources {
  return {
    hostLabelSources: () => ({
      hostLabelById: buildHostLabelById({
        sshTargets: input.listSshTargets(),
        hostSettingOverrides: input.getHostSettingOverrides()
      }),
      hostPlatform: process.platform
    }),
    listAgentStatuses: input.listAgentStatuses,
    getProfileLabel: () => readActiveOrcaProfileLabel(input.userDataPath)
  }
}

/** Project host/agent labels onto the runtime delegate before the public facade. */
export function decoratePluginWorkspaceReadContext(
  delegate: PluginRuntimeDelegate,
  sources: PluginWorkspaceReadContextSources
): PluginRuntimeDelegate {
  return {
    listTerminals: (worktreeSelector, limit, opts) =>
      delegate.listTerminals(worktreeSelector, limit, opts),
    sendTerminal: (handle, action) => delegate.sendTerminal(handle, action),
    dispatchPluginNotification: (notification) => delegate.dispatchPluginNotification(notification),
    resolveActiveWorktreeContext: async () => {
      const context = await delegate.resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      const selected = selectPluginAgentLabels(
        sources.listAgentStatuses?.() ?? [],
        context.worktreeId,
        context.createdWithAgent
      )
      return {
        ...context,
        executionHost:
          context.executionHost ??
          projectPluginExecutionHost(context.hostId, sources.hostLabelSources?.() ?? {}),
        agent:
          context.agent ??
          projectPluginAgentContext({
            type: selected.type,
            model: selected.model,
            profile: sources.getProfileLabel?.() ?? null
          })
      }
    }
  }
}
