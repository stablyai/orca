import { SESSION_TAB_SUBSCRIBE_METHOD } from './session-tab-subscribe-method'
import { terminalCreateFeatureRequirement } from '../agent-launch-feature-requirement'
import { terminalImageViewerSupported } from '../../terminal-image-viewer-env'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  CreateTerminalTab,
  WorktreeTabSelector
} from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import {
  listSessionTabsInventory,
  projectSessionTabsForClient,
  subscribeSessionTabsInventory
} from './session-tabs-inventory'
import { SESSION_TAB_MARKDOWN_METHODS } from './session-tab-markdown-methods'
import { SESSION_TAB_MUTATION_METHODS } from './session-tab-mutation-methods'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  SESSION_TABS_UNSUBSCRIBE_METHOD,
  SESSION_TABS_UNSUBSCRIBE_ALL_METHOD
} from './session-tabs-unsubscribe'

export const SESSION_TAB_METHODS = [
  defineMethod({
    name: 'session.tabs.list',
    permission: 'workspace',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => {
      await prepareStructuredTabsIfSupported({ runtime, clientKind, clientCapabilities })
      return projectSessionTabsForClient(
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId, {
          includeInitialSurfaceLaunch: true,
          includeAgentSenders: clientKind !== 'mobile'
        }),
        clientKind,
        clientCapabilities
      )
    }
  }),
  defineMethod({
    name: 'session.tabs.listAll',
    permission: 'workspace',
    params: null,
    handler: async (_params, context) => {
      await prepareStructuredTabsIfSupported(context)
      return listSessionTabsInventory(context)
    }
  }),
  ...SESSION_TAB_MUTATION_METHODS,
  ...SESSION_TAB_CLOSE_METHODS,
  defineMethod({
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
  }),
  SESSION_TAB_SUBSCRIBE_METHOD,
  SESSION_TABS_UNSUBSCRIBE_METHOD,
  defineStreamingMethod({
    name: 'session.tabs.subscribeAll',
    permission: 'workspace',
    params: null,
    handler: (_params, context, emit) => subscribeSessionTabsInventory(context, emit)
  }),
  SESSION_TABS_UNSUBSCRIBE_ALL_METHOD,
  ...SESSION_TAB_MARKDOWN_METHODS
]
