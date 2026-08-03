import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/plugin-consent-state'
import type { Store } from '../persistence'
import type { PluginService } from './plugin-service'
import type { PluginConsentRequest } from '../../shared/plugins/plugin-consent-request'
import { verifyInstructionalPluginContent } from './plugin-instructional-content-integrity'

/**
 * Single write path for consent + enablement. Consent is recorded as
 * (qualified key → consent fingerprint) — never a bare id — so a capability
 * expansion or addition of trusted Node code requires re-consent. The desktop
 * IPC handlers and the headless RPC methods both route through here.
 */

/** Records the user's consent-dialog answer. Approving stores the CURRENT
 *  consent fingerprint and clears any disable; declining disables so the plugin
 *  never re-prompts on later launches. */
export async function applyPluginConsent(input: {
  store: Store
  pluginService: PluginService
  pluginKey: PluginConsentRequest['pluginKey']
  reviewedFingerprint: PluginConsentRequest['reviewedFingerprint']
  decision: PluginConsentRequest['decision']
  originWebContentsId?: number
}): Promise<void> {
  const { store, pluginService, pluginKey } = input
  const plugin = pluginService.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`cannot record consent for unknown plugin ${pluginKey}`)
  }
  // Why: a same-key install can change while the dialog is open; never apply a
  // decision to capabilities or a worker trust tier the user did not review.
  if (input.decision === 'approve' && plugin.consentFingerprint !== input.reviewedFingerprint) {
    throw new Error(`plugin ${pluginKey} changed since its permissions were reviewed`)
  }
  if (input.decision === 'approve') {
    // Why: IPC and serve callers can bypass the renderer dialog, so main must
    // prove every instructional byte is still reviewable before enabling it.
    await verifyInstructionalPluginContent(plugin)
  }
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  const consents = normalizePluginConsents(settings.pluginConsents)
  if (input.decision === 'approve') {
    consents[pluginKey] = plugin.consentFingerprint
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled], pluginConsents: consents },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.reconcileActivationState()
}

/** Enables/disables an already-consented plugin. Enabling never bypasses
 *  consent: with missing or stale consent the plugin stays pending and the
 *  caller must run the consent flow instead. */
export async function applyPluginEnablement(input: {
  store: Store
  pluginService: PluginService
  pluginKey: string
  enabled: boolean
  originWebContentsId?: number
}): Promise<void> {
  const { store, pluginService, pluginKey, enabled } = input
  if (!pluginService.findValidPlugin(pluginKey)) {
    throw new Error(`cannot change enablement for unknown plugin ${pluginKey}`)
  }
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  if (enabled) {
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled] },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.reconcileActivationState()
}
