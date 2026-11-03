import { PLUGIN_HOST_API } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginCardFields } from '../../../shared/plugins/contributions/plugin-card-fields-state'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'

/** The calling plugin's card fields; false when it contributes no sidebar card to read them. */
export type PluginCardFieldsServices = {
  set(pluginId: string, workspaceId: string, fields: PluginCardFields | null): boolean
}

const api = PLUGIN_HOST_API

export const PLUGIN_CARDS_HANDLERS = {
  'cards.setFields': bind(
    api['cards.setFields'],
    async ({ workspaceId, fields }, { pluginId, services }) => {
      if (!services.cardFields) {
        throw new PluginHostCallError('unavailable', 'this Orca draws no workspace cards')
      }
      if (!services.cardFields.set(pluginId, workspaceId, fields)) {
        throw new PluginHostCallError(
          'invalid_params',
          'this plugin contributes no sidebarCards to read fields'
        )
      }
      return { ok: true as const }
    }
  )
} satisfies Record<string, BoundPluginHostMethod>
