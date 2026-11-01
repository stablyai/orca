import { terminalCreateFeatureRequirement } from '../agent-launch-feature-requirement'
import { terminalImageViewerSupported } from '../../terminal-image-viewer-env'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod } from '../core'
import { CreateTerminalTab } from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

export const SESSION_TAB_CREATE_TERMINAL_METHOD = defineMethod({
  name: 'session.tabs.createTerminal',
  requires: terminalCreateFeatureRequirement,
  permission: 'workspace',
  params: CreateTerminalTab,
  handler: async (params, context) => {
    const { runtime, signal, clientKind, pairedDeviceId, clientCapabilities } = context
    if (params.command) {
      await assertLegacyAiVaultResumeCommandAllowed(params.command, () =>
        runtime.ensureStructuredAgentSessionHost()
      )
    }
    return runtime.createMobileSessionTerminal(params.worktree, {
      ...(params.sourceChatFork ? { sourceChatFork: params.sourceChatFork } : {}),
      terminalImageViewerSupported: terminalImageViewerSupported(context),
      afterTabId: params.afterTabId,
      targetGroupId: params.targetGroupId,
      command: params.command,
      ...(params.shell ? { shellOverride: params.shell } : {}),
      cwd: params.cwd,
      ...(params.env ? { env: params.env } : {}),
      ...(params.envToDelete ? { envToDelete: params.envToDelete } : {}),
      startupCommandDelivery: params.startupCommandDelivery,
      agent: params.agent,
      ...(params.agentPrompt !== undefined ? { agentPrompt: params.agentPrompt } : {}),
      ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
      ...(params.launchToken ? { launchToken: params.launchToken } : {}),
      ...(params.resumeProviderSession
        ? { resumeProviderSession: params.resumeProviderSession }
        : {}),
      ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
      ...(params.viewMode ? { viewMode: params.viewMode } : {}),
      activate: params.activate,
      select: params.select,
      clientNavigationId: pairedDeviceId,
      navigation: resolveRuntimeNavigationTarget({
        navigation: params.navigation,
        clientKind
      }),
      clientMutationId: params.clientMutationId,
      ...(pairedDeviceId
        ? {
            supportsSplitGroupPlacement:
              clientCapabilities?.includes(
                SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY
              ) === true
          }
        : {}),
      // Cancel surface waits on disconnect rather than timing out and rolling back a live tab (#7718).
      signal
    })
  }
})
