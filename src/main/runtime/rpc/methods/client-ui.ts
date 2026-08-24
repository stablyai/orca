import { omitPairingLocalUiFields } from '../../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { normalizeWorktreeCardProperties } from '../../../../shared/worktree/card-properties'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import { defineMethod, type RpcMethod } from '../core'
import {
  FeatureInteractionIdParam,
  PRBotAuthorOverrideUpdate,
  SettingsUpdate,
  UiUpdate
} from './client-ui-schemas'
// Type-only side effect: keeps the schema/PersistedUIState parity assertions in
// the typecheck graph so drift fails the build instead of a paired client.

import { TerminalQuickCommandsUpdate } from './terminal-quick-command-rpc-schema'

const IDENTITY_WORKTREE_CARD_PROPERTIES = new Set<WorktreeCardProperty>([
  'project-name',
  'host-name'
])

function supportsIdentityWorktreeCardProperties(clientCapabilities: readonly string[] | undefined) {
  return (
    clientCapabilities === undefined ||
    clientCapabilities.includes(WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY)
  )
}

function projectUiStateForClient(
  ui: PersistedUIState,
  clientCapabilities: readonly string[] | undefined
) {
  const pairedUi = omitPairingLocalUiFields(ui)
  return supportsIdentityWorktreeCardProperties(clientCapabilities)
    ? pairedUi
    : {
        ...pairedUi,
        worktreeCardProperties: pairedUi.worktreeCardProperties.filter(
          (property) => !IDENTITY_WORKTREE_CARD_PROPERTIES.has(property)
        )
      }
}

export const CLIENT_UI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'settings.get',
    params: null,
    handler: (_params, { runtime }) => ({ settings: runtime.getClientSettings() })
  }),
  defineMethod({
    name: 'settings.update',
    params: SettingsUpdate,
    handler: async (params, { runtime }) => ({
      settings: await runtime.updateClientSettings(params)
    })
  }),
  defineMethod({
    name: 'settings.getTerminalQuickCommands',
    params: null,
    // Why: command bodies can total ~240 KB, so keep unrelated settings reads
    // from carrying them over every paired/relay connection.
    handler: (_params, { runtime }) => ({
      terminalQuickCommands: runtime.getClientTerminalQuickCommands()
    })
  }),
  defineMethod({
    name: 'settings.updateTerminalQuickCommands',
    params: TerminalQuickCommandsUpdate,
    handler: (params, { runtime }) => ({
      terminalQuickCommands: runtime.updateClientTerminalQuickCommands(params.mutation)
    })
  }),
  defineMethod({
    name: 'settings.updatePRBotAuthorOverride',
    params: PRBotAuthorOverrideUpdate,
    handler: (params, { runtime }) => ({
      settings: runtime.updateClientPRBotAuthorOverride(params)
    })
  }),
  defineMethod({
    name: 'ui.get',
    params: null,
    handler: (_params, { runtime, clientCapabilities }) => ({
      ui: projectUiStateForClient(runtime.getUIState(), clientCapabilities),
      capabilities: [WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY]
    })
  }),
  defineMethod({
    name: 'ui.set',
    params: UiUpdate,
    // Why the fields are dropped here rather than removed from the schema: UiUpdate is strict, so
    // an unlisted key would make the dispatcher reject an old client's ENTIRE payload.
    handler: (params, { runtime, clientCapabilities }) => {
      const pairedUpdates = omitPairingLocalUiFields(params) as Partial<PersistedUIState>
      if (
        pairedUpdates.worktreeCardProperties &&
        !supportsIdentityWorktreeCardProperties(clientCapabilities)
      ) {
        const retainedIdentityProperties = runtime
          .getUIState()
          .worktreeCardProperties.filter((property) =>
            IDENTITY_WORKTREE_CARD_PROPERTIES.has(property)
          )
        pairedUpdates.worktreeCardProperties = normalizeWorktreeCardProperties([
          ...pairedUpdates.worktreeCardProperties,
          ...retainedIdentityProperties
        ])
      }
      return {
        ui: projectUiStateForClient(runtime.updateUIState(pairedUpdates), clientCapabilities),
        capabilities: [WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY]
      }
    }
  }),
  defineMethod({
    name: 'ui.recordFeatureInteraction',
    params: FeatureInteractionIdParam,
    handler: (params, { runtime }) => ({
      ui: omitPairingLocalUiFields(runtime.recordFeatureInteraction(params))
    })
  })
]
