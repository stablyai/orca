import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/approval/plugin-consent-state'
import type { Store } from '../persistence/loading-store/store'
import { enableIfDataPlugin } from './catalog/plugin-one-click-enable'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { applyPluginConsent } from './plugin-enablement'
import type { PluginService } from './plugin-service'

/**
 * Turns on shipped plugins that are content only, as a catalog click would; Orca's own release
 * vouches for their bytes. One the user turned off stays off, and code still waits for review.
 */
export async function approveBundledContentPlugins(input: {
  pluginKeys: readonly string[]
  /** Read per plugin, so a switch-off made while another is approved still counts. */
  readConsentState: () => {
    consents: Readonly<Record<string, string>>
    disabledPlugins: readonly string[]
  }
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  approve: (pluginKey: string, reviewedFingerprint: string) => Promise<void>
}): Promise<void> {
  for (const pluginKey of input.pluginKeys) {
    const plugin = input.findValidPlugin(pluginKey)
    const { consents, disabledPlugins } = input.readConsentState()
    if (
      !plugin ||
      disabledPlugins.includes(pluginKey) ||
      consents[pluginKey] === plugin.consentFingerprint
    ) {
      continue
    }
    try {
      await enableIfDataPlugin({
        pluginKey,
        installedFingerprint: plugin.consentFingerprint,
        findValidPlugin: input.findValidPlugin,
        approve: input.approve
      })
    } catch (error) {
      // Why per plugin: one refused approval must not leave the other shipped plugins off.
      console.warn(`[plugins] failed to turn on bundled ${pluginKey}:`, error)
    }
  }
}

/** Approves shipped content plugins against the live settings once discovery has run. */
export async function approveBundledPluginsFromStore(
  store: Store,
  pluginService: PluginService,
  pluginKeys: readonly string[]
): Promise<void> {
  await pluginService.whenReady()
  await approveBundledContentPlugins({
    pluginKeys,
    readConsentState: () => {
      const settings = store.getSettings()
      return {
        consents: normalizePluginConsents(settings.pluginConsents),
        disabledPlugins: normalizePluginIdList(settings.disabledPlugins)
      }
    },
    findValidPlugin: (pluginKey) => pluginService.findValidPlugin(pluginKey),
    approve: (pluginKey, reviewedFingerprint) =>
      applyPluginConsent({
        store,
        pluginService,
        pluginKey,
        reviewedFingerprint,
        decision: 'approve'
      })
  })
}
