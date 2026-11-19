import { defineMethod } from '../../core'
import { terminalCreateFeatureRequirement } from '../../startup/agent-launch-feature-requirement'
import { terminalImageViewerSupported } from '../../../terminal/launch/terminal-image-viewer-env'
import { resolveRuntimeNavigationTarget } from '../../../../../shared/remote-runtime/session-graph/runtime-navigation'
import { CreateTerminalTab } from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../../ai-vault/structured-sessions/structured-session-ownership'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { runOwnedSessionStartup } from './session-tabs-owned-startup'

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
    const create = (onPtySpawnDispatched?: () => void) =>
      runtime.createMobileSessionTerminal(params.worktree, {
        ...(onPtySpawnDispatched ? { onPtySpawnDispatched } : {}),
        ...(params.sourceChatFork ? { sourceChatFork: params.sourceChatFork } : {}),
        terminalImageViewerSupported: terminalImageViewerSupported(context),
        afterTabId: params.afterTabId,
        targetGroupId: params.targetGroupId,
        command: params.command,
        ...(params.requireOwnedStartup ? { requireOwnedStartup: true } : {}),
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
        ...(params.trustWorktreeId ? { trustWorktreeId: params.trustWorktreeId } : {}),
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
    return params.requireOwnedStartup ? runOwnedSessionStartup(params, context, create) : create()
  }
})
