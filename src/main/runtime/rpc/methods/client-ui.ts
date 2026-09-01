import { omitPairingLocalUiFields } from '../../../../shared/pairing-local-ui-fields'
import { z } from 'zod'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean } from '../schemas'
import {
  FeatureInteractionIdParam,
  PRBotAuthorOverrideUpdate,
  SettingsUpdate,
  UiUpdate
} from './client-ui-schemas'
// Type-only side effect: keeps the schema/PersistedUIState parity assertions in
// the typecheck graph so drift fails the build instead of a paired client.

import { TerminalQuickCommandsUpdate } from './terminal-quick-command-rpc-schema'

// Why: agent catalog/reference state is owned by the atomic mutation APIs, not
// the generic settings write. A legacy client that includes any of these keys is
// rejected wholesale with client_upgrade_required (no partial apply) so it cannot
// erase a custom reference it is too old to represent. Fields never shipped by an
// old settings.update client (custom/tombstone arrays, revisions, reference
// owners) are absent from the schema above and fail strict() before reaching the
// handler; they are listed here only for defense in depth.
const AGENT_REJECTED_SETTINGS_UPDATE_KEYS = [
  'defaultTuiAgent',
  'disabledTuiAgents',
  'agentCmdOverrides',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'customTuiAgents',
  'deletedCustomTuiAgents',
  'agentCatalogRevision',
  'agentReferenceRevision',
  'terminalQuickCommands',
  'commitMessageAi',
  'sourceControlAi'
] as const

// Why: the catalog projection is budgeted at 512 KiB, so a client that only wants
// settings opts out and fetches it from settings.agentCatalog.get instead. Omitted
// keeps the legacy piggyback: an old client has no other way to read the catalog.
const SettingsGet = z.object({ includeAgentCatalog: OptionalBoolean }).strict()

export const CLIENT_UI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'settings.get',
    params: SettingsGet,
    handler: (params, { runtime }) => ({
      settings: runtime.getClientSettings(),
      ...(params.includeAgentCatalog === false
        ? {}
        : { agentCatalog: runtime.getAgentCatalogSnapshot() }),
      // Small capability descriptor; the full snapshot ships from
      // settings.agentReferences.get so the two never compete under one frame.
      agentReferences: { version: 1 as const, revision: runtime.getAgentReferenceRevision() }
    })
  }),
  defineMethod({
    name: 'settings.agentCatalog.get',
    params: null,
    // Why: dedicated read so the catalog rides its own frame instead of every
    // unrelated settings.get; a client that gets method_not_found here is talking
    // to an old host and falls back to the settings.get piggyback.
    handler: (_params, { runtime }) => ({ agentCatalog: runtime.getAgentCatalogSnapshot() })
  }),
  defineMethod({
    name: 'settings.agentReferences.get',
    params: null,
    handler: (_params, { runtime }) => ({ agentReferences: runtime.getAgentReferenceSnapshot() })
  }),
  defineMethod({
    name: 'settings.update',
    params: SettingsUpdate,
    handler: async (params, { runtime }) => {
      const provided = params as Record<string, unknown>
      for (const key of AGENT_REJECTED_SETTINGS_UPDATE_KEYS) {
        if (key in provided) {
          throw new Error('client_upgrade_required')
        }
      }
      return { settings: await runtime.updateClientSettings(params) }
    }
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
    handler: (_params, { runtime }) => ({ ui: omitPairingLocalUiFields(runtime.getUIState()) })
  }),
  defineMethod({
    name: 'ui.set',
    params: UiUpdate,
    // Why the fields are dropped here rather than removed from the schema: UiUpdate is strict, so
    // an unlisted key would make the dispatcher reject an old client's ENTIRE payload.
    handler: (params, { runtime }) => ({
      ui: omitPairingLocalUiFields(
        runtime.updateUIState(omitPairingLocalUiFields(params) as Partial<PersistedUIState>)
      )
    })
  }),
  defineMethod({
    name: 'ui.recordFeatureInteraction',
    params: FeatureInteractionIdParam,
    handler: (params, { runtime }) => ({
      ui: omitPairingLocalUiFields(runtime.recordFeatureInteraction(params))
    })
  })
]
