import { normalizeJiraQuickFilterState } from '../../../../shared/jira-quick-filters'
import { JiraQuickFilterStateParam } from '../../../../shared/rpc-contract/jira-quick-filter-params'
import {
  normalizeJiraSavedFilterState,
  mutateJiraSavedFilterState
} from '../../../../shared/jira/jira-saved-filters'
import { JiraSavedFilterMutationParam } from '../../../../shared/rpc-contract/jira-saved-filter-params'
import {
  omitPairingLocalUiFields,
  type PairedUiState
} from '../../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { defineMethod, type RpcContext } from '../core'
import { isHostOwnPhone } from '../host-own-phone'
import {
  NativeChatSessionOptionsMutation,
  PRBotAuthorOverrideUpdate,
  SettingsUpdate
} from '../../../../shared/rpc-contract/client-settings-params'
import {
  FeatureInteractionIdParam,
  UiUpdate
} from '../../../../shared/rpc-contract/client-ui-params'
// Type-only side effect: keeps the schema/PersistedUIState parity assertions in
// the typecheck graph so drift fails the build instead of a paired client.

import { TerminalQuickCommandsUpdate } from '../../../../shared/rpc-contract/terminal-quick-command-params'
import { AgentLaunchSettingsMutation } from '../../../../shared/rpc-contract/agent-launch-settings-params'
import { projectTerminalQuickCommandsForClient } from './terminal-quick-command-long-prompt-capability'

function uiForCaller(
  state: PersistedUIState,
  context: Pick<RpcContext, 'clientKind' | 'pairedDeviceParentId'>
): PairedUiState & Pick<PersistedUIState, 'hideWorkspacesFromOtherDevices'> {
  const ui = omitPairingLocalUiFields(state)
  // Why always sent: its presence tells the phone this host shares the filter; an older host omits
  // it, and the phone then keeps its local value.
  return isHostOwnPhone(context)
    ? { ...ui, hideWorkspacesFromOtherDevices: state.hideWorkspacesFromOtherDevices === true }
    : ui
}

export const CLIENT_UI_METHODS = [
  defineMethod({
    name: 'ui.getJiraQuickFilters',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) =>
      normalizeJiraQuickFilterState(runtime.getUIState().jiraQuickFilterState)
  }),
  defineMethod({
    name: 'ui.setJiraQuickFilters',
    permission: 'workspace',
    params: JiraQuickFilterStateParam,
    handler: (params, { runtime }) => {
      const state = normalizeJiraQuickFilterState(params)
      runtime.updateUIState({ jiraQuickFilterState: state })
      return state
    }
  }),
  defineMethod({
    name: 'ui.getJiraSavedFilters',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) =>
      normalizeJiraSavedFilterState(runtime.getUIState().jiraSavedFilterState)
  }),
  defineMethod({
    name: 'ui.mutateJiraSavedFilters',
    permission: 'workspace',
    params: JiraSavedFilterMutationParam,
    handler: (params, { runtime }) => {
      const state = mutateJiraSavedFilterState(runtime.getUIState().jiraSavedFilterState, params)
      runtime.updateUIState({ jiraSavedFilterState: state })
      return state
    }
  }),
  defineMethod({
    name: 'settings.getAgentLaunch',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({ settings: runtime.getClientAgentLaunchSettings() })
  }),
  defineMethod({
    name: 'settings.mutateAgentLaunch',
    permission: 'settings-write',
    params: AgentLaunchSettingsMutation,
    handler: async (params, { runtime }) => ({
      settings: await runtime.mutateClientAgentLaunchSettings(params)
    })
  }),
  defineMethod({
    name: 'settings.get',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({ settings: runtime.getClientSettings() })
  }),
  defineMethod({
    name: 'settings.update',
    permission: 'settings-write',
    params: SettingsUpdate,
    handler: async (params, { runtime }) => ({
      settings: await runtime.updateClientSettings(params)
    })
  }),
  defineMethod({
    name: 'settings.getTerminalQuickCommands',
    permission: 'workspace',
    params: null,
    // Why: command bodies can total ~240 KB, so keep unrelated settings reads
    // from carrying them over every paired/relay connection.
    handler: (_params, ctx) => ({
      terminalQuickCommands: projectTerminalQuickCommandsForClient(
        ctx.runtime.getClientTerminalQuickCommands(),
        ctx
      )
    })
  }),
  defineMethod({
    name: 'settings.updateTerminalQuickCommands',
    permission: 'settings-write',
    params: TerminalQuickCommandsUpdate,
    handler: (params, ctx) => ({
      terminalQuickCommands: projectTerminalQuickCommandsForClient(
        ctx.runtime.updateClientTerminalQuickCommands(params.mutation),
        ctx
      )
    })
  }),
  defineMethod({
    name: 'settings.updatePRBotAuthorOverride',
    permission: 'settings-write',
    params: PRBotAuthorOverrideUpdate,
    handler: (params, { runtime }) => ({
      settings: runtime.updateClientPRBotAuthorOverride(params)
    })
  }),
  defineMethod({
    name: 'settings.mutateNativeChatSessionOptions',
    permission: 'settings-write',
    params: NativeChatSessionOptionsMutation,
    handler: (params, { runtime }) => {
      runtime.updateClientNativeChatSessionOptions(params)
      return { ok: true as const }
    }
  }),
  defineMethod({
    name: 'ui.get',
    permission: 'workspace',
    params: null,
    handler: (_params, context) => ({ ui: uiForCaller(context.runtime.getUIState(), context) })
  }),
  defineMethod({
    name: 'ui.set',
    permission: 'workspace',
    params: UiUpdate,
    // Why the fields are dropped here rather than removed from the schema: UiUpdate is strict, so
    // an unlisted key would make the dispatcher reject an old client's ENTIRE payload.
    handler: (params, context) => {
      const ownPhoneFilter =
        isHostOwnPhone(context) && params.hideWorkspacesFromOtherDevices !== undefined
          ? { hideWorkspacesFromOtherDevices: params.hideWorkspacesFromOtherDevices }
          : {}
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: UiUpdate is checked key-for-key against PersistedUIState (ui-state-schema-parity-checks.ts); only optionality differs.
      const updates = {
        ...omitPairingLocalUiFields(params),
        ...ownPhoneFilter
      } as Partial<PersistedUIState>
      return { ui: uiForCaller(context.runtime.updateUIState(updates), context) }
    }
  }),
  defineMethod({
    name: 'ui.recordFeatureInteraction',
    permission: 'workspace',
    params: FeatureInteractionIdParam,
    handler: (params, context) => ({
      ui: uiForCaller(context.runtime.recordFeatureInteraction(params), context)
    })
  })
]
